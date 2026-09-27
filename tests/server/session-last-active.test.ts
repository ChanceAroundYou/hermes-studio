import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `sessions.last_active` used to be written only when a run started and
 * recomputed when it ended, so for the whole duration of a long run it sat at
 * the start time. Every other client (a second browser, a phone) and the
 * sidebar's own poll then showed a busy session as idle at the moment it was
 * busiest.
 *
 * The fix advances it at the single chokepoint every message passes through,
 * and monotonically.
 */
describe('session last_active advances while a run is in flight', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let base = 0
  let idleBefore = 0

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
    // createSession always stamps last_active with "now"; the tests build on
    // top of whatever it produced rather than inventing an older baseline.
    store.createSession({ id: 'run-1', profile: 'default', title: 'long run' })
    store.createSession({ id: 'other', profile: 'default', title: 'idle' })
    base = store.getSession('run-1')!.last_active
    idleBefore = store.getSession('other')!.last_active
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  const lastActive = () => store.getSession('run-1')!.last_active

  it('moves forward as each message is persisted, before the run ends', () => {
    store.addMessage({ session_id: 'run-1', role: 'user', content: 'hi', timestamp: base + 30 })
    expect(lastActive()).toBe(base + 30)

    store.addMessage({ session_id: 'run-1', role: 'assistant', content: 'working', timestamp: base + 90 })
    expect(lastActive()).toBe(base + 90)
  })

  it('advances from a batch using the newest timestamp in it', () => {
    store.addMessages([
      { session_id: 'run-1', role: 'user', content: 'a', timestamp: base + 20 },
      { session_id: 'run-1', role: 'assistant', content: 'b', timestamp: base + 75 },
      { session_id: 'run-1', role: 'assistant', content: 'c', timestamp: base + 40 },
    ])
    expect(lastActive()).toBe(base + 75)
  })

  it('never moves backwards on a late or back-dated message', () => {
    store.addMessage({ session_id: 'run-1', role: 'assistant', content: 'now', timestamp: base + 120 })
    store.addMessage({ session_id: 'run-1', role: 'user', content: 'stale replay', timestamp: base - 600 })
    expect(lastActive()).toBe(base + 120)
  })

  it('only touches the session that received a message', () => {
    store.addMessage({ session_id: 'run-1', role: 'user', content: 'hi', timestamp: base + 45 })
    expect(store.getSession('other')!.last_active).toBe(idleBefore)
  })

  it('does not create a session row for an unknown id', () => {
    store.addMessage({ session_id: 'ghost', role: 'user', content: 'hi', timestamp: base + 45 })
    expect(store.getSession('ghost')).toBeNull()
  })
})
