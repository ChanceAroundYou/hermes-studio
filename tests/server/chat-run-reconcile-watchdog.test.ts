import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Watchdog (reconcileStaleRuns) regression test.
 *
 * The bug: when a terminal event is lost (dropped stale chunks after a resume,
 * killed socket, dead worker), the server's SessionState keeps isWorking=true.
 * Every resume then answers `isWorking: true`, so the client shows "thinking"
 * forever and the user's next message is queued instead of sent. The watchdog
 * is the last-resort safety net: it asks the bridge and, when the bridge says
 * nothing is running, forces the state idle and emits run.completed.
 */

const getSessionMock = vi.fn()
const emitExternalEventSpy = vi.fn()
const socketForQueuedRunSpy = vi.fn()
const dequeueNextQueuedRunSpy = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: vi.fn(() => 42),
  createSession: vi.fn(),
  getSession: (...args: unknown[]) => getSessionMock(...args),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionDetailPaginated: vi.fn(() => null),
  updateMessageDisplayContent: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  pushState: vi.fn(),
  replaceState: vi.fn(),
  getOrCreateSession: vi.fn(),
}))

// ChatRunSocket's field initializers call createPrimaryAgentBridge(), which
// throws unless the runtime is configured. Provide a stub bridge factory.
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => ({
    statusIfLoaded: vi.fn(async () => ({ ok: true, running: false, exists: false })),
  })),
}))

import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

function makeServer(bridgeStatus: () => Promise<Record<string, unknown>>) {
  // Minimal fake for `io.of('/chat-run')`.
  const nsp = {
    adapter: { rooms: { get: vi.fn(() => new Set()) } },
    to: vi.fn(() => ({ emit: vi.fn() })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => nsp) } as any

  const server = new ChatRunSocket(io as any)
  // Replace the bridge and the emit hook.
  ;(server as any).bridge = {
    statusIfLoaded: vi.fn(bridgeStatus),
  }
  ;(server as any).emitExternalEvent = emitExternalEventSpy
  ;(server as any).socketForQueuedRun = socketForQueuedRunSpy
  ;(server as any).dequeueNextQueuedRun = dequeueNextQueuedRunSpy
  ;(server as any).backgroundPendingCount = vi.fn(() => 0)
  return { server, nsp }
}

describe('reconcileStaleRuns watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 's1', profile: 'default', source: 'cli' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clears a leaked isWorking when the bridge reports nothing running', async () => {
    const { server } = makeServer(async () => ({ ok: true, running: false, exists: false }))
    ;(server as any).sessionMap.set('s1', {
      messages: [],
      isWorking: true,
      runStartedAt: Date.now() - 20 * 60 * 1000, // 20 min stale
      runId: 'run-stale',
      events: [],
      queue: [],
      profile: 'default',
      source: 'cli',
    })

    await (server as any).reconcileStaleRuns()

    const state = (server as any).sessionMap.get('s1')
    expect(state.isWorking).toBe(false)
    expect(state.runId).toBeUndefined()
    // A run.completed must be emitted so attached clients stop showing thinking.
    expect(emitExternalEventSpy).toHaveBeenCalledWith(
      's1',
      'run.completed',
      expect.objectContaining({ reconciled: true }),
    )
  })

  it('skips sessions that are not stale yet (younger than the threshold)', async () => {
    const { server } = makeServer(async () => ({ ok: true, running: false, exists: false }))
    ;(server as any).sessionMap.set('s1', {
      messages: [],
      isWorking: true,
      runStartedAt: Date.now() - 1000, // 1s old — must NOT be reconciled
      runId: 'run-fresh',
      events: [],
      queue: [],
      profile: 'default',
      source: 'cli',
    })

    await (server as any).reconcileStaleRuns()

    const state = (server as any).sessionMap.get('s1')
    expect(state.isWorking).toBe(true)
    expect(emitExternalEventSpy).not.toHaveBeenCalled()
  })

  it('skips sessions the bridge still reports as running', async () => {
    const { server } = makeServer(async () => ({ ok: true, running: true, exists: true }))
    ;(server as any).sessionMap.set('s1', {
      messages: [],
      isWorking: true,
      runStartedAt: Date.now() - 20 * 60 * 1000,
      runId: 'run-live',
      events: [],
      queue: [],
      profile: 'default',
      source: 'cli',
    })

    await (server as any).reconcileStaleRuns()

    expect((server as any).sessionMap.get('s1').isWorking).toBe(true)
    expect(emitExternalEventSpy).not.toHaveBeenCalled()
  })

  it('does not clear a run when the bridge status lookup fails', async () => {
    const { server } = makeServer(async () => { throw new Error('bridge down') })
    ;(server as any).sessionMap.set('s1', {
      messages: [],
      isWorking: true,
      runStartedAt: Date.now() - 20 * 60 * 1000,
      runId: 'run-unknown',
      events: [],
      queue: [],
      profile: 'default',
      source: 'cli',
    })

    await (server as any).reconcileStaleRuns()

    expect((server as any).sessionMap.get('s1').isWorking).toBe(true)
    expect(emitExternalEventSpy).not.toHaveBeenCalled()
  })
})
