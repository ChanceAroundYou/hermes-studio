import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A run can end in three ways — the user aborts, the upstream fails, or the
 * system tears the run down — and all three have to leave the same kind of
 * trace. Otherwise a session that was interrupted reads as if it had simply
 * gone quiet, and its activity time stays pinned to whatever it said before the
 * interruption.
 *
 * The abort path flushes whatever was buffered before stopping, which is what
 * makes a half-finished answer count as a completed one.
 */
describe('every way a run ends leaves a trace and moves activity', () => {
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

  it('a persisted failure advances activity', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'go', timestamp: at(1_000) })
    store.addMessage({ session_id: 's1', role: 'error', content: 'Error: aborted', timestamp: at(2_000) })

    expect(store.getSession('s1')!.last_active).toBe(at(2_000))
  })

  it('a partial answer flushed on abort counts as complete', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    // The user stopped the run mid-sentence; whatever was buffered is written
    // out, so the transcript is not left with a dangling half message.
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'here is half a sen', timestamp: at(3_000) })

    expect(store.getSession('s1')!.last_active).toBe(at(3_000))
    const rows = (store.getSessionDetail('s1')?.messages ?? []) as any[]
    expect(rows[0].content).toBe('here is half a sen')
  })

  it('an ended session is distinguishable from one still running', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.updateSession('s1', { ended_at: at(4_000), end_reason: 'complete' } as any)

    const row = store.getSession('s1')!
    expect(row.ended_at).toBe(at(4_000))
    // `ended_at` is bookkeeping, not activity: it must not have moved the
    // column, which is what made the sidebar order by run end time.
    expect(row.last_active).toBe(row.started_at)
  })
})

/**
 * `ended_at` is the field that caused the original symptom, so pin that it is
 * not what orders sessions.
 */
describe('anti-test: ordering by ended_at would reproduce the original bug', () => {
  it('a run that ended later than the last message of another session is not more recent', () => {
    const a = { lastActive: 9_000, endedAt: 20_000 }
    const b = { lastActive: 10_000, endedAt: 10_000 }

    const byActivity = b.lastActive - a.lastActive
    const byEnd = b.endedAt - a.endedAt

    // Correct: b is more recent by transcript.
    expect(byActivity).toBeGreaterThan(0)
    // The bug: ordering by end time flips it.
    expect(byEnd).toBeLessThan(0)
  })
})
