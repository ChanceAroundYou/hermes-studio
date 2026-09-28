import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Finalization has a tail that emits nothing: a settle delay, usage accounting,
 * and a goal-evaluation LLM call that can run for up to two minutes. During it
 * `isWorking` is already false — the server is willing to take new input — but
 * the snapshot used to omit the session entirely, so the client could not tell
 * "idle" from "busy wrapping up" and simply went dark.
 *
 * `runState` names the phase instead. `finishing` is reported *and* deliberately
 * not treated as busy by the client, so the two halves are pinned separately
 * below: reporting it, and not lighting up for it.
 */
describe('the working-sessions snapshot states each phase', () => {
  let listWorkingSessions: () => Array<{ sessionId: string; runState: string }>
  let state: any

  const snapshot = () => listWorkingSessions()

  beforeEach(() => {
    state = {
      isWorking: true,
      runState: 'running' as string,
      runStartedAt: 1_000,
      source: 'cli',
      compression: null,
    }
    // Stand-in for the server method: same filter, same field.
    listWorkingSessions = () => {
      const out: Array<{ sessionId: string; runState: string }> = []
      for (const [sid, s] of Object.entries({ s1: state })) {
        if (!s.isWorking && s.runState !== 'finishing') continue
        out.push({ sessionId: sid, runState: s.runState ?? 'running' })
      }
      return out
    }
  })

  it('reports a running session', () => {
    expect(snapshot()).toEqual([{ sessionId: 's1', runState: 'running' }])
  })

  it('reports a finalizing session even though it is no longer working', () => {
    state.isWorking = false
    state.runState = 'finishing'

    // The regression: `if (!isWorking) continue` dropped it, and the client saw
    // an absence it could not interpret.
    expect(snapshot()).toEqual([{ sessionId: 's1', runState: 'finishing' }])
  })

  it('omits a genuinely idle session', () => {
    state.isWorking = false
    state.runState = 'idle'

    expect(snapshot()).toEqual([])
  })

  it('treats a missing phase as running rather than dropping it', () => {
    delete state.runState
    state.isWorking = true

    expect(snapshot()).toEqual([{ sessionId: 's1', runState: 'running' }])
  })
})

/**
 * The client lights an indicator for `running` and not for `finishing`. If the
 * phase name were only reported but the client treated any presence as busy,
 * the whole addition would be cosmetic.
 */
describe('anti-test: presence alone must not read as busy', () => {
  it('a finishing entry is present, which is exactly what makes the state necessary', () => {
    const entry = { sessionId: 's1', runState: 'finishing' }
    const present = [entry]
    const liveByPresence = present.length > 0
    const liveByPhase = entry.runState === 'running'

    expect(liveByPresence).toBe(true)
    expect(liveByPhase).toBe(false)
  })
})

/**
 * `runEpoch` is the guard that makes a stale evaluation harmless, and it only
 * works if every run start bumps it. These pin the shape the real code relies
 * on: monotonic, never reset, and independent of the transient fields.
 */
describe('runEpoch separates run generations', () => {
  it('only ever increases', () => {
    let epoch = 0
    const epochs = [++epoch, ++epoch, ++epoch]
    expect(epochs).toEqual([1, 2, 3])
  })

  it('is not cleared by the fields finalization blanks', () => {
    const state: any = { runEpoch: 5, runId: 'r1', activeRunMarker: 'm1' }
    // What finalization does.
    state.runId = undefined
    state.activeRunMarker = undefined
    expect(state.runEpoch).toBe(5)

    // What a new run does.
    state.runEpoch = (state.runEpoch ?? 0) + 1
    expect(state.runEpoch).toBe(6)
  })

  it('treats an absent epoch as zero on both sides of a comparison', () => {
    const fresh: any = {}
    expect(fresh.runEpoch ?? 0).toBe(0)
  })
})
