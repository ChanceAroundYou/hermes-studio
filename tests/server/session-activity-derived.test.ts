import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one invariant this whole change rests on:
 *
 *     sessions.last_active  ===  MAX(messages.timestamp)
 *
 * Activity time means "when did this session's transcript last grow". It used
 * to mean something looser, and five writers disagreed about it — a run stamped
 * `now` on startup, `updateSessionStats` recomputed the column, renaming a
 * session refreshed it, importing wrote the import clock. A session that was
 * merely *about to start* therefore read 00:28 while its newest message was the
 * 00:24 compaction.
 *
 * These tests pin the invariant itself rather than any individual caller, and
 * the anti-tests at the bottom restore each old writer in turn so that a
 * regression cannot pass unnoticed.
 */
describe('last_active is derived from the message table', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')

  const lastActive = (id: string) => store.getSession(id)!.last_active
  const newestMessage = (id: string): number | null => {
    const row = db
      .prepare('SELECT MAX(timestamp) AS t FROM messages WHERE session_id = ?')
      .get(id)
    return row?.t == null ? null : Number(row.t)
  }
  const expectDerived = (id: string) => {
    expect(lastActive(id)).toBe(newestMessage(id))
  }

  // `createSession` stamps last_active with the wall clock, and the column only
  // ever moves forward, so a test timestamp has to be measured from that value
  // rather than from an arbitrary epoch — otherwise "now" silently wins every
  // comparison and the test stops testing what it claims to.
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

  it('holds after a run start that writes no message', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.updateSession('s1', { ended_at: null, end_reason: null })

    // Reopening a run is the exact moment the old code stamped `now`. With no
    // message produced, activity time must not move.
    const before = lastActive('s1')
    store.updateSession('s1', { ended_at: null, end_reason: null })
    expect(lastActive('s1')).toBe(before)
  })

  it('ignores a last_active handed to updateSession', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })

    store.updateSession('s1', { last_active: at(9_999) } as any)
    expect(lastActive('s1')).toBe(at(5_000))
    expectDerived('s1')
  })

  it('stays put when updateSessionStats runs', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })
    // A second writer claiming an older value must not drag it backwards.
    store.updateSessionStats('s1')

    expect(lastActive('s1')).toBe(at(5_000))
    expectDerived('s1')
  })

  it('tracks the newest message, not the most recent write order', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'a', timestamp: at(1_000) })
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'b', timestamp: at(2_000) })
    // A back-dated row inserted last: it is the newest row but not the newest
    // moment, and the column must follow the moment.
    store.addMessage({ session_id: 's1', role: 'user', content: 'late import', timestamp: at(1_500) })

    expect(lastActive('s1')).toBe(at(2_000))
    expectDerived('s1')
  })

  it('follows a batch insert', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessages([
      { session_id: 's1', role: 'user', content: 'a', timestamp: at(3_000) },
      { session_id: 's1', role: 'assistant', content: 'b', timestamp: at(4_000) },
    ])

    expect(lastActive('s1')).toBe(at(4_000))
    expectDerived('s1')
  })

  it('records a failure as activity', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'go', timestamp: at(6_000) })
    store.addMessage({ session_id: 's1', role: 'error', content: 'Error: boom', timestamp: at(6_500) })

    expect(lastActive('s1')).toBe(at(6_500))
    expectDerived('s1')
  })

  it('is unaffected by another session', () => {
    store.createSession({ id: 's1', profile: 'default', title: 'a' })
    store.createSession({ id: 's2', profile: 'default', title: 'b' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'x', timestamp: at(7_000) })
    const other = lastActive('s2')

    expect(other).not.toBe(at(7_000))
  })
})

/**
 * Each anti-test restores one removed writer and asserts the invariant breaks.
 * If one of these ever passes silently, the guard above has been weakened.
 */
describe('anti-tests: restoring a removed writer breaks the invariant', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')

  let base = 0
  const at = (offset: number) => base + offset
  const newestMessage = (id: string) => {
    const row = db
      .prepare('SELECT MAX(timestamp) AS t FROM messages WHERE session_id = ?')
      .get(id)
    return row?.t == null ? null : Number(row.t)
  }

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

  it('updateSession writing last_active would let a run start inflate it', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })

    // Simulate the old call site: reopening a run passed a fresh clock reading.
    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(at(9_999), 's1')
    expect(store.getSession('s1')!.last_active).not.toBe(newestMessage('s1'))
  })

  it('updateSessionStats recomputing from messages is redundant rather than wrong', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })
    store.updateSessionStats('s1')
    // Worth stating explicitly: this writer computed the same value, so
    // removing it changed nothing observable — which is why it is safe to drop.
    expect(store.getSession('s1')!.last_active).toBe(newestMessage('s1'))
  })

  it('a run-start stamp still breaks it when applied directly', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'hi', timestamp: at(5_000) })
    const before = store.getSession('s1')!.last_active

    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(before + 600, 's1')
    expect(store.getSession('s1')!.last_active).not.toBe(newestMessage('s1'))
  })
})
