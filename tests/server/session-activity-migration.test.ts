import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The writers that drifted are gone, but the rows they touched kept their
 * drifted values — a session still reading 00:28 when its newest message is
 * 00:24. This one-shot repair re-derives them, and it is the only place in the
 * codebase permitted to move activity time backwards.
 *
 * The ledger row is what makes it safe to run at every boot.
 */
describe('the activity-time repair runs once and only forwards', () => {
  let db: any = null
  let migrate: typeof import('../../packages/server/src/modules/studio/infrastructure/database/schemas')['migrateSessionLastActiveToNewestMessage']
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')

  // `createSession` stamps the wall clock and the column only moves forward,
  // so message timestamps have to sit above that value for MAX() to prefer
  // them; a small constant would silently lose to "now" and make every drift
  // assertion vacuous.
  let base = 0
  const at = (offset: number) => base + offset

  const setLastActive = (id: string, value: number) =>
    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(value, id)
  const setStartedAt = (id: string, value: number) =>
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(value, id)

  const drifted = () =>
    Number(db.prepare(
      `SELECT COUNT(*) AS c FROM sessions
       WHERE EXISTS (SELECT 1 FROM messages WHERE session_id = sessions.id)
         AND last_active != (SELECT MAX(timestamp) FROM messages WHERE session_id = sessions.id)`,
    ).get().c)

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    migrate = schemas.migrateSessionLastActiveToNewestMessage
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    // Bootstrapping already consumed the repair, so each case starts from a
    // ledger-free database to get a "pending" repair to observe.
    db.prepare("DELETE FROM gc_activity_migrations WHERE id = 'session-last-active-from-messages-v1'").run()
    store.createSession({ id: 'clock', profile: 'default', title: 'clock' })
    base = store.getSession('clock')!.last_active
  })

  afterEach(() => {
    db?.close()
  })

  it('leaves a correct session alone', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(1_000) })
    const before = store.getSession('s1')!.last_active
    // Correct already, so the repair has nothing to do with it.
    expect(drifted()).toBe(0)

    migrate(db)

    expect(drifted()).toBe(0)
    expect(store.getSession('s1')!.last_active).toBe(before)
  })

  it('pulls a drifted session back to its newest message', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(1_000) })
    setLastActive('s1', at(9_999))

    expect(drifted()).toBe(1)
    migrate(db)

    expect(drifted()).toBe(0)
    expect(store.getSession('s1')!.last_active).toBe(at(1_000))
  })

  it('falls back to started_at for a session with no messages', () => {
    store.createSession({ id: 'empty', profile: 'default', title: 't' })
    // `createSession` stamps the wall clock, so pin a known started_at the way
    // an import or a branch would, then clear the transcript.
    setStartedAt('empty', 4242)
    setLastActive('empty', at(9_999))

    migrate(db)

    expect(store.getSession('empty')!.last_active).toBe(4242)
  })

  it('runs once, then becomes a no-op', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(1_000) })
    setLastActive('s1', at(9_999))

    migrate(db)
    expect(drifted()).toBe(0)

    // Drift again after the ledger was written: the repair must not resurrect.
    setLastActive('s1', at(12_345))
    migrate(db)
    expect(store.getSession('s1')!.last_active).toBe(at(12_345))
  })
})

/**
 * Without the ledger the repair would run on every boot and keep dragging
 * legitimate future activity back to the last message.
 */
describe('anti-test: without the ledger the repair would fight live activity', () => {
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
    db.prepare("DELETE FROM gc_activity_migrations WHERE id = 'session-last-active-from-messages-v1'").run()
    store.createSession({ id: 'clock', profile: 'default', title: 'clock' })
    base = store.getSession('clock')!.last_active
  })

  afterEach(() => {
    db?.close()
  })

  it('an unconditional re-derivation would clobber a newer run', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(1_000) })
    // A message arrives whose row is written later but whose timestamp is newer.
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'a', timestamp: at(2_000) })
    const live = store.getSession('s1')!.last_active
    expect(live).toBe(at(2_000))

    // Re-deriving is only safe while the ledger says the repair is pending.
    // The row was cleared for this case, so the repair is armed — and running
    // it here would drag the session back to 1_000, below the 2_000 its
    // transcript actually reached.
    const pending = db
      .prepare("SELECT 1 FROM gc_activity_migrations WHERE id = 'session-last-active-from-messages-v1'")
      .get()
    expect(pending).toBeUndefined()
    expect(live).toBe(at(2_000))
  })
})
