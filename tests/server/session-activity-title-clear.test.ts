import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Two more writers that used to disagree with "activity means a message
 * arrived": naming a session, and emptying it.
 *
 * Renaming is a label, not a moment. Emptying a session genuinely has no
 * transcript left, so falling back to `started_at` is the honest answer — but
 * that fallback is written in raw SQL and is therefore outside the reach of the
 * `updateSession` guard, so it needs its own pin.
 */
describe('a session name is not activity', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let base = 0
  const at = (offset: number) => base + offset

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'clock', profile: 'default', title: 'clock' })
    base = store.getSession('clock')!.last_active
  })

  afterEach(() => {
    db?.close()
  })

  it('leaves activity alone when only the title changes', () => {
    store.createSession({ id: 's1', profile: 'default', title: 'old name' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(1_000) })
    const before = store.getSession('s1')!.last_active

    store.updateSession('s1', { title: 'a generated name' } as any)

    expect(store.getSession('s1')!.title).toBe('a generated name')
    expect(store.getSession('s1')!.last_active).toBe(before)
  })
})

describe('emptying a session resets activity to when it began', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let base = 0
  const at = (offset: number) => base + offset

  const startedAt = (id: string) =>
    Number(db.prepare('SELECT started_at AS v FROM sessions WHERE id = ?').get(id).v)

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'clock', profile: 'default', title: 'clock' })
    base = store.getSession('clock')!.last_active
  })

  afterEach(() => {
    db?.close()
  })

  it('falls back to started_at, not the wall clock', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })
    expect(store.getSession('s1')!.last_active).toBe(at(5_000))

    store.clearSessionMessages('s1')

    expect(store.getSession('s1')!.last_active).toBe(startedAt('s1'))
  })

  it('leaves the session with no transcript', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })

    store.clearSessionMessages('s1')

    expect(store.getMessageCount('s1')).toBe(0)
  })
})

/**
 * If the reset were written with the wall clock instead of `started_at`, an
 * emptied session would look brand new in the sidebar.
 */
describe('anti-test: resetting to now would make an emptied session look fresh', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
  })

  afterEach(() => {
    db?.close()
  })

  it('after a message has landed, now and started_at are far apart', () => {
    // Comparing them within the same second proves nothing, so give the
    // session a message with a timestamp well past its creation. A `now`-based
    // reset would then collapse that distance and float the emptied session to
    // the top of the sidebar; the real reset pins it to the beginning.
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    const start = Number(db.prepare('SELECT started_at AS v FROM sessions WHERE id = ?').get('s1').v)
    const activity = start + 86_400
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: activity })
    store.clearSessionMessages('s1')

    const afterClear = store.getSession('s1')!.last_active
    expect(afterClear).toBe(start)
    // A `now` reset would have landed at today's wall clock, a day ahead.
    expect(activity - start).toBe(86_400)
    expect(afterClear).toBeLessThan(activity)
  })
})
