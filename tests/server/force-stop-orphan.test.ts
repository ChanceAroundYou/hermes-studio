import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateSessionStatsMock = vi.fn()
const updateSessionMock = vi.fn()
const flushBridgePendingToDbMock = vi.fn()
const flushResponseRunToDbMock = vi.fn()
const replaceStateMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const codingAgentRunManagerMock = vi.hoisted(() => ({
  hasSession: vi.fn(() => false),
  stop: vi.fn(() => false),
}))
const ekkoBackgroundMock = vi.hoisted(() => ({
  has: vi.fn(() => false),
  abort: vi.fn(async () => 0),
}))
const registryMock = vi.hoisted(() => ({
  findLiveRun: vi.fn(() => null as any),
  forceKillLiveRun: vi.fn(() => ({ killed: false })),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({
  flushResponseRunToDb: flushResponseRunToDbMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  replaceState: replaceStateMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/live-run-registry', () => ({
  findLiveRun: registryMock.findLiveRun,
  forceKillLiveRun: registryMock.forceKillLiveRun,
}))

vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  hasGlobalEkkoBackgroundTasks: ekkoBackgroundMock.has,
  abortGlobalEkkoBackgroundTasks: ekkoBackgroundMock.abort,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  chatCodingAgentRunManager: codingAgentRunManagerMock,
  hasChatEkkoBackgroundTasks: ekkoBackgroundMock.has,
  abortChatEkkoBackgroundTasks: ekkoBackgroundMock.abort,
}))

function makeHarness() {
  const emit = vi.fn()
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit })),
  }
  const socket = { connected: true, emit: vi.fn() }
  return { emit, nsp, socket }
}

/**
 * A server restart drops the in-memory run but leaves the agent child alive. The
 * old guard saw no run and returned "ignored", so stop never stopped anything.
 */
describe('force stop survives a server restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    codingAgentRunManagerMock.hasSession.mockReturnValue(false)
    codingAgentRunManagerMock.stop.mockReturnValue(false)
    ekkoBackgroundMock.has.mockReturnValue(false)
    ekkoBackgroundMock.abort.mockResolvedValue(0)
    registryMock.findLiveRun.mockReturnValue(null)
    registryMock.forceKillLiveRun.mockReturnValue({ killed: false })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 })
  })

  /**
   * The common post-restart shape: the session still claims source
   * 'coding_agent', so the guard lets it through, but the run manager is empty.
   * The old code reported `synced: true` here and killed nothing.
   */
  it('force kills the orphan agent when the run manager lost the session', async () => {
    registryMock.findLiveRun.mockReturnValue({
      sessionId: 'session-1',
      runId: 'run-9',
      pid: 4242,
      agentId: 'claude',
      ownerPid: 111,
      startedAt: Date.now(),
    })
    registryMock.forceKillLiveRun.mockReturnValue({ killed: true, pid: 4242, runId: 'run-9' })

    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'coding_agent',
      runId: 'run-9',
    } as any

    await handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      new Map([['session-1', state]]),
      { interrupt: vi.fn() },
      vi.fn(),
    )

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(registryMock.forceKillLiveRun).toHaveBeenCalledWith('session-1')
  })

  it('leaves the in-memory path alone when the run manager did stop something', async () => {
    registryMock.findLiveRun.mockReturnValue({
      sessionId: 'session-1',
      runId: 'run-9',
      pid: 4242,
      agentId: 'claude',
      ownerPid: 111,
      startedAt: Date.now(),
    })
    codingAgentRunManagerMock.stop.mockReturnValue(true)

    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'coding_agent',
      runId: 'run-9',
    } as any

    await handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      new Map([['session-1', state]]),
      { interrupt: vi.fn() },
      vi.fn(),
    )

    // The child was already reaped in memory; a second kill would be a redundant
    // signal against a pid that may since have been recycled.
    expect(registryMock.forceKillLiveRun).not.toHaveBeenCalled()
  })

  it('kills the orphan when the guard short-circuits as "no active run"', async () => {
    registryMock.findLiveRun.mockReturnValue({
      sessionId: 'session-1',
      runId: 'run-9',
      pid: 4242,
      agentId: 'claude',
      ownerPid: 111,
      startedAt: Date.now(),
    })
    registryMock.forceKillLiveRun.mockReturnValue({ killed: true, pid: 4242, runId: 'run-9' })

    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    // No source, no runId, no controller: the guard's second clause matches.
    const state = { messages: [], isWorking: true, isAborting: false, events: [], queue: [] } as any

    await handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      new Map([['session-1', state]]),
      { interrupt: vi.fn() },
      vi.fn(),
    )

    expect(registryMock.forceKillLiveRun).toHaveBeenCalledWith('session-1')
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      synced: true,
      force_killed: true,
      killed_pid: 4242,
    }))
    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
  })

  it('never claims a force kill when the orphan pid was already gone', async () => {
    registryMock.findLiveRun.mockReturnValue({
      sessionId: 'session-1',
      runId: 'run-9',
      pid: 4242,
      agentId: 'claude',
      ownerPid: 111,
      startedAt: Date.now(),
    })
    registryMock.forceKillLiveRun.mockReturnValue({ killed: false, pid: 4242, runId: 'run-9' })

    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = { messages: [], isWorking: true, isAborting: false, events: [], queue: [] } as any

    await handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      new Map([['session-1', state]]),
      { interrupt: vi.fn() },
      vi.fn(),
    )

    expect(emit).not.toHaveBeenCalledWith('abort.completed', expect.objectContaining({ force_killed: true }))
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({ ignored: true }))
  })
})
