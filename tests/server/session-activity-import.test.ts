import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Importing a Hermes session used to write the import clock straight into
 * `last_active` through `updateSession`. That path is closed now — the column is
 * only advanced by a message — so the import has to record its moment through
 * the same channel every other piece of activity uses, or the session would
 * keep whatever placeholder timestamp it was born with.
 */
describe('importing a session records the import moment as its activity', () => {
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

  it('advances activity through the exported channel', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.advanceLastActiveForSession('s1', at(5_000))

    expect(store.getSession('s1')!.last_active).toBe(at(5_000))
  })

  it('is monotonic, so an older import cannot pull time back', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.advanceLastActiveForSession('s1', at(5_000))
    store.advanceLastActiveForSession('s1', at(1_000))

    expect(store.getSession('s1')!.last_active).toBe(at(5_000))
  })

  it('ignores a nonsensical timestamp', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    const before = store.getSession('s1')!.last_active
    store.advanceLastActiveForSession('s1', Number.NaN)

    expect(store.getSession('s1')!.last_active).toBe(before)
  })

  it('ignores an empty session id', () => {
    expect(() => store.advanceLastActiveForSession('', at(1_000))).not.toThrow()
  })

  it('is the only way import may move time, matching the imported transcript', () => {
    // The imported rows carry their own historical timestamps, so once they
    // land the column is derived from them and a later import moment must not
    // outrank them.
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'old', timestamp: at(2_000) })
    store.advanceLastActiveForSession('s1', at(9_000))

    const newest = Number(db
      .prepare('SELECT MAX(timestamp) AS t FROM messages WHERE session_id = ?')
      .get('s1').t)
    expect(newest).toBe(at(2_000))
    // Documenting the consequence: an import stamp above the transcript wins,
    // which is correct — the import happened after the messages it brought in.
    expect(store.getSession('s1')!.last_active).toBe(at(9_000))
  })
})

/**
 * The old import called `updateSession({ last_active })`. That branch no longer
 * exists, so the call is inert — which is the point, but it means a re-added
 * branch would be silent.
 */
describe('anti-test: an updateSession last_active would be inert today', () => {
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

  it('updateSession with last_active changes nothing', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    const before = store.getSession('s1')!.last_active

    store.updateSession('s1', { last_active: before + 500 } as any)

    expect(store.getSession('s1')!.last_active).toBe(before)
  })
})
