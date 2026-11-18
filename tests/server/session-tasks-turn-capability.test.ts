// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

// Booting the ChatRunSocket graph is heavy on 0.8.20.
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
// Session goals are stored in SQLite. The assertion here is about whether the
// turn reaches the session id at all, so the store is stubbed rather than booted.
vi.mock('../../packages/server/src/modules/studio/repositories/session-task-store', () => ({
  getSessionTasks: vi.fn(() => ({ session_id: 'session-3', items: [], revision: 1 })),
  getSessionTasksState: vi.fn(() => ({ session_id: 'session-3', profile: 'research', source: 'cli', items: [], revision: 1 })),
  commitSessionTasks: vi.fn(),
  commitSessionTaskStatus: vi.fn(),
  listSessionTaskItems: vi.fn(() => []),
}))

function makeServerHarness() {
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn(() => ({ emit: vi.fn() })),
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
  return { io, namespace, socket }
}

/**
 * Upstream 0.8.20 (0ee02be8b / #3499) made session goals a per-turn capability:
 * `TaskPlanRuns.begin()` records `sessionTasksEnabled` on the binding and
 * `sessionForContext()` rejects with 409 when the binding says the turn may not
 * use them. beginTaskPlanRun takes the flag and the browser path relies on the
 * default, so forwarding it is the whole feature.
 */
async function boot() {
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const { io } = makeServerHarness()
  const server = new ChatRunSocket(io as any)
  return server as any
}

function seedRun(server: any, sessionId: string, profile = 'research') {
  server.sessionMap.set(sessionId, {
    isWorking: true,
    isAborting: false,
    activeRunMarker: 'turn-1',
    runStartedAt: Date.now(),
    source: 'cli',
  })
}

describe('session goals stay available on the turn that started them', () => {
  it('binds an ordinary turn as allowed to use session goals', async () => {
    const server = await boot()
    seedRun(server, 'session-1')

    const contextId = server.beginTaskPlanRun('session-1', 'research')
    expect(typeof contextId).toBe('string')

    // The turn is live, so the capability check has to reach the session id.
    expect(server.taskPlanRuns.sessionForContext(contextId, 'research')).toBe('session-1')
  })

  it('keeps the gate working for a background delegation, which must not get goals', async () => {
    const server = await boot()
    seedRun(server, 'session-2')

    const contextId = server.beginTaskPlanRun('session-2', 'research', false)
    expect(() => server.taskPlanRuns.sessionForContext(contextId, 'research'))
      .toThrow(/Session goals are unavailable/)
  })

  it('lists session tasks for the current turn instead of rejecting it', async () => {
    const server = await boot()
    seedRun(server, 'session-3')
    // The session has to exist for the task store to answer at all.
    const sessionStore = await import('../../packages/server/src/modules/studio/repositories/session-store')
    ;(sessionStore.getSession as any).mockReturnValue({
      id: 'session-3', profile: 'research', source: 'cli', title: 'goal test',
    })

    const contextId = server.beginTaskPlanRun('session-3', 'research')
    const snapshot = server.listSessionTasks(contextId, 'research')
    expect(snapshot).toBeTruthy()
  })
})
