import { beforeEach, describe, expect, it, vi } from 'vitest'

// This file boots the whole ChatRunSocket graph, which is slow on 0.8.20.
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
  loadSessionStateFromDb: vi.fn(),
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run', () => ({
  handleCodingAgentRun: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => ({
  handleSessionCommand: vi.fn(), isSessionCommand: vi.fn(() => false), parseSessionCommand: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => ({})),
}))
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
  listProfileNamesFromDisk: vi.fn(() => ['default', 'research', 'mail']),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
const userCanAccessProfileMock = vi.hoisted(() => vi.fn((_user: unknown, _profile: string) => true))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: userCanAccessProfileMock,
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
    id: 'socket-1',
    connected: true,
    handshake: { auth: {}, query: { profile: 'default' } as Record<string, unknown> },
    data: {} as Record<string, unknown>,
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn(),
  }
  return { emitted, io, namespace, socket }
}

const connected = (socket: any) => socket.join.mock.calls.map((call: unknown[]) => String(call[0]))

describe('the pending-interaction rooms one socket joins', () => {
  beforeEach(() => {
    userCanAccessProfileMock.mockReset()
    userCanAccessProfileMock.mockImplementation((_user: unknown, profile: string) => profile === 'research')
  })

  it('joins a room for every profile the user can reach, and refuses the rest', async () => {
    // A prompt raised on `research` was invisible while the user looked at
    // `default`: the socket only ever sat in the active profile's room, and the
    // event is published to the room of the profile that asked.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    socket.data.user = { id: 7, role: 'user' }
    socket.handshake.query = { profile: 'default', pending_profiles: JSON.stringify(['research', 'other']) }

    ;(server as any).onConnection(socket)

    expect(connected(socket)).toContain('pending-interactions:default')
    expect(connected(socket)).toContain('pending-interactions:research')
    expect(connected(socket)).not.toContain('pending-interactions:other')
  })

  it('lets a super admin join every profile it asks for', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    socket.data.user = { id: 1, role: 'super_admin' }
    socket.handshake.query = { profile: 'default', pending_profiles: JSON.stringify(['research', 'mail']) }

    ;(server as any).onConnection(socket)

    expect(connected(socket)).toContain('pending-interactions:research')
    expect(connected(socket)).toContain('pending-interactions:mail')
    // The admin's access is what allows it, not the absence of a user record.
    expect(userCanAccessProfileMock).not.toHaveBeenCalled()
  })

  it('falls back to the active profile alone when the payload is unusable', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const server = new ChatRunSocket(makeServerHarness().io as any)

    for (const broken of [undefined, '', 'not json', '"a string"', JSON.stringify({ a: 1 })]) {
      const { io, socket } = makeServerHarness()
      const instance = new ChatRunSocket(io as any)
      socket.data.user = { id: 7, role: 'user' }
      socket.handshake.query = { profile: 'default', pending_profiles: broken }
      expect(() => (instance as any).onConnection(socket)).not.toThrow()
      expect(connected(socket).filter(room => room.startsWith('pending-interactions:')))
        .toEqual(['pending-interactions:default'])
    }
    expect(server).toBeTruthy()
  })

  it('never widens a connection that is not authenticated', async () => {
    // Without a user there is nobody to check the requested profiles against, so
    // the socket keeps exactly the access it had before this feature existed.
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    socket.handshake.query = { profile: 'default', pending_profiles: JSON.stringify(['research', 'mail']) }

    ;(server as any).onConnection(socket)

    expect(connected(socket).filter(room => room.startsWith('pending-interactions:')))
      .toEqual(['pending-interactions:default'])
    expect(userCanAccessProfileMock).not.toHaveBeenCalled()
  })
})

/**
 * The run-start sweep was the other half of the bug fixed in this phase.
 *
 * `beginTaskPlanRun` called `clarificationRuns.finishSession(sessionId)`, so
 * every outstanding question died the moment the next turn began -- including
 * the one the user was looking at. A prompt belongs to the turn that raised it;
 * only that turn ending may settle it.
 */
describe("starting a run leaves the previous run's prompts alone", () => {
  it('does not settle the session when a new run begins', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const runs = (server as any).clarificationRuns
    const settle = vi.spyOn(runs, 'finishSession')
    runs.begin('context-1', 'session-1', 'research', () => ({ isWorking: true, activeRunMarker: 'turn-1' }))
    const waiting = runs.request('context-1', 'research', { question: 'Which folder?' })
    settle.mockClear()

    ;(server as any).beginTaskPlanRun('session-1', 'default')

    expect(settle).not.toHaveBeenCalled()

    // Still the same prompt, still live, and ended by its own turn.
    expect(runs.respond('session-1', 'nobody-holds-this', 'x')).toEqual({ handled: false, resolved: false })
    runs.finishSession('session-1')
    await expect(waiting).resolves.toMatchObject({ reason: 'cancelled' })
    expect(socket).toBeTruthy()
  })
})
