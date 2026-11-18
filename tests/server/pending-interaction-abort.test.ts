import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

vi.mock('../../packages/server/src/modules/studio/services/files/session-uploads', () => ({
  recordSessionUploadAttachments: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/socket-access', () => ({
  bindSessionShareSocket: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/task-plan-store', () => ({
  saveTaskPlan: vi.fn(), listTaskPlansForPage: vi.fn(() => []),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run', () => ({
  handleEkkoAgentRun: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run', () => ({
  handleBridgeRun: vi.fn(async () => {}), resumeBridgeRun: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  loadSessionStateFromDb: vi.fn(), resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run', () => ({
  handleCodingAgentRun: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => ({
  handleSessionCommand: vi.fn(), isSessionCommand: vi.fn(() => false), parseSessionCommand: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({ AgentBridgeClient: vi.fn(() => ({})) }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({ ensureReady: vi.fn(), getRuntimeState: vi.fn() })),
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  getChatCodingAgentMcpServers: vi.fn(() => ({})),
  resolveChatEkkoMcpServers: vi.fn(() => ({})),
  createPrimaryAgentBridge: vi.fn(() => ({ status: vi.fn() })),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(), ensureReady: vi.fn(), getRuntimeState: vi.fn() })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: {
    resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
    resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
    stop: vi.fn(),
  },
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  respondToChatEkkoToolApproval: vi.fn(() => ({ handled: false, resolved: false })),
  respondToChatEkkoClarification: vi.fn(() => ({ handled: false, resolved: false })),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionNotificationPreview: vi.fn(() => null),
  getSession: vi.fn(() => undefined),
  getSessionMetadata: vi.fn(() => undefined),
  getSessionDetail: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ mcp_servers: {} })),
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default', 'research']),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(), isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

function makeServerHarness() {
  const emitted: Array<{ room: unknown; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn((room: unknown) => ({
      emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })),
    })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => namespace) }
  const socket = {
    id: 'socket-1', connected: true,
    handshake: { auth: {}, query: { profile: 'default' } as Record<string, unknown> },
    data: {} as Record<string, unknown>,
    emit: vi.fn(), join: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })), on: vi.fn(),
  }
  return { emitted, io, namespace, socket }
}

/** The room a pending-interaction event must reach to be seen at all. */
const pendingRooms = (emitted: Array<{ room: unknown; event: string }>, event: string) =>
  emitted.filter(entry => entry.event === event && String(entry.room).startsWith('pending-interactions:'))

function seedWaitingPrompt(server: any, emitted: Array<{ room: unknown; event: string; payload: any }>) {
  const runs = server.clarificationRuns
  runs.begin('context-1', 'session-1', 'research', () => ({ isWorking: true, activeRunMarker: 'turn-1' }))
  const waiting = runs.request('context-1', 'research', { question: 'Which folder?' })
  const clarifyId = pendingRooms(emitted, 'clarify.requested')[0]?.payload.clarify_id
  return { waiting, clarifyId }
}

/**
 * Stopping a run that is parked on a question.
 *
 * The reported symptom was `Stop was not confirmed by the run. Press stop
 * again.` with no way out but a page reload. Two things have to hold: the stop
 * has to settle the question the run is parked on, and it still has to reach its
 * own terminal event afterwards.
 */
describe('stopping a run that is waiting on a question', () => {
  it('settles the outstanding prompt, marked as aborted rather than cancelled', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, emitted } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const { waiting, clarifyId } = seedWaitingPrompt(server, emitted)

    ;(server as any).finishTaskPlanRun('session-1', 'abort.completed')

    await expect(waiting).resolves.toMatchObject({ reason: 'aborted', response: '' })
    const settled = pendingRooms(emitted, 'clarify.resolved')
    expect(settled).toHaveLength(1)
    expect(settled[0].payload).toMatchObject({ clarify_id: clarifyId, resolved: true, reason: 'aborted' })
  })

  it('reaches the raising profile, not the profile that happens to be active', async () => {
    // The turn knows which profile it belongs to; delivery used to be inferred
    // from three fallbacks, and the last of them is `default`.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, emitted } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    seedWaitingPrompt(server, emitted)

    const asked = pendingRooms(emitted, 'clarify.requested')
    expect(asked).toHaveLength(1)
    expect(asked[0].room).toBe('pending-interactions:research')

    ;(server as any).finishTaskPlanRun('session-1', 'abort.completed')
    expect(pendingRooms(emitted, 'clarify.resolved')[0].room).toBe('pending-interactions:research')
  })

  it('still reaches abort.completed: the stop is not swallowed by the question', async () => {
    // The deadlock: the run never produced a terminal event, so nothing ever
    // released the client's "aborting" state and the button was unusable.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, emitted } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const { waiting } = seedWaitingPrompt(server, emitted)
    const release = vi.spyOn(server as any, 'releaseTaskPlanRunState')

    ;(server as any).finishTaskPlanRun('session-1', 'abort.completed', { interrupted: true })

    // The terminal handler ran all the way through: it released the run state,
    // which is the precondition for the abort to be reported as completed.
    expect(release).toHaveBeenCalledWith(undefined)
    await expect(waiting).resolves.toMatchObject({ reason: 'aborted' })
  })

  it('leaves prompts of other sessions alone', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const runs = (server as any).clarificationRuns
    runs.begin('context-1', 'session-1', 'research', () => ({ isWorking: true, activeRunMarker: 'turn-1' }))
    const other = runs.request('context-1', 'research', { question: 'Mine' })
    runs.begin('context-2', 'session-2', 'research', () => ({ isWorking: true, activeRunMarker: 'turn-2' }))

    ;(server as any).finishTaskPlanRun('session-2', 'abort.completed')

    // session-1's question is untouched and still ends on its own turn.
    runs.finishSession('session-1', 'context-1')
    await expect(other).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('does not mistake a queue boundary finishing for a user stop', async () => {
    // Upstream #3404 narrowed this after a queue boundary could finish with a
    // stale `interrupted` flag left over from a removed queued input. A run that
    // completed on its own must finalize its plan as ended, otherwise the plan
    // claims the user stopped something they never stopped.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const finish = vi.spyOn((server as any).taskPlanRuns, 'finish')

    const contextId = (server as any).beginTaskPlanRun('session-1', 'research')
    ;(server as any).finishTaskPlanRun('session-1', 'run.completed', { interrupted: true }, contextId)

    expect(finish).toHaveBeenCalledWith(contextId, 'ended')
  })

  it('finalizes a real stop as interrupted', async () => {
    // The other half of the narrowed expression: `abort.completed` on its own
    // must still record an interrupted plan, with no payload flag involved.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const finish = vi.spyOn((server as any).taskPlanRuns, 'finish')
    const contextId = (server as any).beginTaskPlanRun('session-1', 'research')
    ;(server as any).finishTaskPlanRun('session-1', 'abort.completed', undefined, contextId)
    expect(finish).toHaveBeenCalledWith(contextId, 'interrupted')
  })

  it('counts a run that failed while the socket was aborting as interrupted', async () => {
    // The live `isAborting` half: the terminal event arrived as a failure, but
    // the user had already pressed Stop, so the plan must not claim a plain run
    // failure.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const finish = vi.spyOn((server as any).taskPlanRuns, 'finish')
    const contextId = (server as any).beginTaskPlanRun('session-2', 'research')
    ;(server as any).sessionMap.set('session-2', { isWorking: true, isAborting: true, activeRunMarker: 'turn-2' })
    ;(server as any).finishTaskPlanRun('session-2', 'run.failed', undefined, contextId)
    expect(finish).toHaveBeenCalledWith(contextId, 'interrupted')
  })

  it('names the turn ending and the user stopping differently', async () => {
    // Both settle the prompt, but the card says something different in each case.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, emitted } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const { waiting } = seedWaitingPrompt(server, emitted)

    ;(server as any).finishTaskPlanRun('session-1', 'run.completed')

    await expect(waiting).resolves.toMatchObject({ reason: 'cancelled' })
    expect(pendingRooms(emitted, 'clarify.resolved')[0].payload.reason).toBe('cancelled')
  })
})
