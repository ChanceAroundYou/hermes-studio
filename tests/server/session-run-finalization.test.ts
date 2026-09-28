import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Finalization emits `run.completed`, clears `isWorking`, and *then* runs a
 * goal-evaluation LLM call that can take up to two minutes while producing no
 * messages. A message sent inside that window therefore starts a new run
 * directly instead of queueing, and the old evaluation comes back describing
 * the conversation as it stood before that run.
 *
 * The guard is `runEpoch`: a counter that only ever increases and is never
 * reset. That detail is the whole point. `runId` and `activeRunMarker` are
 * cleared at the start of finalization, so capturing either of them at the
 * evaluation call site yields a constant `undefined` and any later comparison
 * trivially passes — the first version of this fix did exactly that and
 * silently guarded nothing. The anti-test at the bottom pins that failure mode
 * so it cannot come back.
 *
 * These call the real handler rather than a re-implementation of its rule, so
 * a change to the production guard cannot pass by leaving the test untouched.
 */
type Args = Parameters<
  typeof import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')['maybeEnqueueGoalContinuation']
>[0]

const makeState = (runEpoch = 7) => ({
  runEpoch,
  queue: [] as any[],
  messages: [] as any[],
  compression: undefined,
  isWorking: false,
  activeRunMarker: undefined,
  runId: undefined,
})

const makeArgs = (state: any, goalEpoch: number, resolve: Promise<any>): Args =>
  ({
    nsp: { to: () => ({ emit: vi.fn() }) },
    socket: { emit: vi.fn() } as any,
    sessionId: 's1',
    state,
    bridge: { goalEvaluate: vi.fn().mockReturnValue(resolve) } as any,
    profile: 'default',
    modelContext: {},
    modelGroups: [],
    instructions: '',
    finalResponse: 'all done',
    runSource: 'cli',
    goalEpoch,
  }) as unknown as Args

const verdict = (should_continue: boolean, prompt = 'keep going') => ({
  reason: 'ok',
  should_continue,
  continuation_prompt: should_continue ? prompt : '',
  message: '',
  verdict: 'continue',
})

let handler: typeof import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')['maybeEnqueueGoalContinuation']

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
  handler = mod.maybeEnqueueGoalContinuation
})

describe('goal continuation is dropped when a newer run has taken over', () => {
  it('queues the continuation when the session is still ours', async () => {
    const state = makeState(7)
    const args = makeArgs(state, state.runEpoch, Promise.resolve(verdict(true)))

    await handler(args)

    expect(state.queue).toHaveLength(1)
    expect(state.queue[0].input).toBe('keep going')
  })

  it('queues nothing when the judge says stop', async () => {
    const state = makeState(7)
    const args = makeArgs(state, state.runEpoch, Promise.resolve(verdict(false)))

    await handler(args)

    expect(state.queue).toHaveLength(0)
  })

  it('drops the verdict when a newer run started and already finished', async () => {
    const state = makeState(7)
    let release: (v: any) => void = () => {}
    const pending = new Promise<any>(resolve => { release = resolve })
    const args = makeArgs(state, state.runEpoch, pending)

    const running = handler(args)
    // A new run arrives, completes, and blanks the transient fields again.
    state.runEpoch = 8
    state.runId = undefined
    state.activeRunMarker = undefined
    release(verdict(true))
    await running

    expect(state.queue).toHaveLength(0)
  })

  it('drops the verdict while a newer run is still in flight', async () => {
    const state = makeState(7)
    let release: (v: any) => void = () => {}
    const pending = new Promise<any>(resolve => { release = resolve })
    const args = makeArgs(state, state.runEpoch, pending)

    const running = handler(args)
    state.runEpoch = 9
    state.activeRunMarker = 'cli_run_new'
    state.runId = 'run-2'
    release(verdict(true))
    await running

    expect(state.queue).toHaveLength(0)
  })

  it('queues nothing when a real (non-goal) run is already queued', async () => {
    const state = makeState(7)
    state.queue.push({ queue_id: 'user-reply', input: 'actually, do this instead' })
    const args = makeArgs(state, state.runEpoch, Promise.resolve(verdict(true)))

    await handler(args)

    expect(state.queue).toHaveLength(1)
    expect(state.queue[0].queue_id).toBe('user-reply')
  })

  it('treats a missing epoch as zero on both sides', async () => {
    const state: any = { queue: [], messages: [] }
    const args = makeArgs(state, 0, Promise.resolve(verdict(true)))

    await handler(args)

    expect(state.queue).toHaveLength(1)
  })

  it('survives an evaluation failure without queueing', async () => {
    const state = makeState(7)
    const args = makeArgs(state, state.runEpoch, Promise.reject(new Error('bridge down')))

    await expect(handler(args)).resolves.toBeUndefined()
    expect(state.queue).toHaveLength(0)
  })
})

/**
 * Guards the exact defect the first implementation had: identity read from a
 * field that finalization had already blanked.
 */
describe('anti-test: identity taken from a cleared field guards nothing', () => {
  it('compares undefined to undefined and would let a stale verdict through', async () => {
    const state = makeState(7)
    let release: (v: any) => void = () => {}
    const pending = new Promise<any>(resolve => { release = resolve })
    const args = makeArgs(state, state.runEpoch, pending)

    // The first implementation captured the marker here, at the call site.
    const capturedMarker = state.activeRunMarker
    const capturedRunId = state.runId

    const running = handler(args)
    // A newer run comes and goes, leaving the same undefined values behind.
    state.runEpoch = 8
    state.activeRunMarker = 'cli_run_x'
    state.activeRunMarker = undefined
    release(verdict(true))
    await running

    // Real guard: epoch moved, verdict dropped.
    expect(state.queue).toHaveLength(0)
    // What the marker/runId check would have concluded: "still mine".
    expect(capturedMarker === state.activeRunMarker).toBe(true)
    expect(capturedRunId === state.runId).toBe(true)
    expect(capturedMarker).toBeUndefined()
  })
})
