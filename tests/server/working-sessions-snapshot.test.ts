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
    listLiveSessions: vi.fn(() => [
      { sessionId: 'agent-1', runId: 'ar-1', processing: true, startedAt: 2_000 },
      { sessionId: 'agent-idle', runId: 'ar-2', processing: false, startedAt: 3_000 },
    ]),
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

function makeHarness() {
  const namespace = { adapter: { rooms: new Map() }, to: vi.fn(() => ({ emit: vi.fn() })), use: vi.fn(), on: vi.fn() }
  return { io: { of: vi.fn(() => namespace) } }
}

async function boot() {
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const { io } = makeHarness()
  return new ChatRunSocket(io as any) as any
}

/**
 * `GET /api/studio/chat-run/working-sessions` reads `server.listWorkingSessions()`
 * behind a `typeof === 'function'` guard, so a socket that does not implement the
 * method makes the endpoint answer `{ sessions: [] }` instead of failing. The
 * visible symptom is the sidebar never showing "thinking" for a session the user
 * is not currently looking at -- including a background session whose run is live.
 */
describe('the working-sessions snapshot comes from the real socket', () => {
  it('answers the endpoint with the sessions that hold a live run', async () => {
    const server = await boot()
    server.sessionMap.set('s1', {
      isWorking: true, runState: 'running', runStartedAt: 1_000, source: 'cli',
      events: [], messages: [], runId: 'r-1', compression: null,
    })

    expect(typeof server.listWorkingSessions).toBe('function')
    const rows = server.listWorkingSessions()
    expect(rows.map((row: any) => row.sessionId)).toContain('s1')
    expect(rows.find((row: any) => row.sessionId === 's1')).toMatchObject({
      runState: 'running',
      runStartedAt: 1_000,
      runId: 'r-1',
      backgroundPending: 0,
    })
  })

  it('reports a finalizing session that is no longer isWorking', async () => {
    const server = await boot()
    server.sessionMap.set('finishing-1', {
      isWorking: false, runState: 'finishing', runStartedAt: 1_000, source: 'cli',
      events: [], messages: [], runId: undefined, compression: null,
    })

    const row = server.listWorkingSessions().find((entry: any) => entry.sessionId === 'finishing-1')
    expect(row).toMatchObject({ runState: 'finishing' })
  })

  it('omits an idle session rather than reporting a stale phase', async () => {
    const server = await boot()
    // `runState` is written at run start and nothing writes it back, so an idle
    // session can still be stamped 'running'. Reporting the implied phase is what
    // lets the sidebar actually go dark.
    server.sessionMap.set('idle-1', {
      isWorking: false, runState: 'running', runStartedAt: 1_000, source: 'cli',
      events: [], messages: [], compression: null,
    })

    expect(server.listWorkingSessions().map((entry: any) => entry.sessionId)).not.toContain('idle-1')
  })

  it('reports a delegation-only session as idle, not as the stale phase it was stamped with', async () => {
    // The exact leak the phase derivation exists for: `runState` is written when
    // a run starts and nothing ever writes it back. A coding-agent session is
    // never `isWorking`, so it is excluded from the snapshot -- until a
    // delegation puts it back in, carrying the stale 'running' with it. The
    // client then believed the server said "busy" on every poll, so the ring
    // never went out and no completion was ever reported.
    const server = await boot()
    server.sessionMap.set('deleg-only', {
      isWorking: false,
      runState: 'running',
      runStartedAt: 1_000,
      source: 'coding_agent',
      events: [],
      messages: [],
      compression: null,
      backgroundDelegations: { sub1: { status: 'running' } },
    })

    const row = server.listWorkingSessions().find((entry: any) => entry.sessionId === 'deleg-only')
    expect(row).toBeTruthy()
    expect(row.backgroundPending).toBeGreaterThan(0)
    expect(row.runState).toBe('idle')
  })

  it('carries the compression snapshot so a poll can heal a missed completion', async () => {
    const server = await boot()
    server.sessionMap.set('compressing-1', {
      isWorking: true, runState: 'running', runStartedAt: 1_000, source: 'cli',
      events: [], messages: [], compression: {
        stage: 'started', messageCount: 12, beforeTokens: 90_000, afterTokens: 0,
        compressed: null, startedAt: 900,
      },
    })

    const row = server.listWorkingSessions().find((entry: any) => entry.sessionId === 'compressing-1')
    expect(row.compression).toMatchObject({ stage: 'started', beforeTokens: 90_000 })
  })

  it('includes a coding-agent session, which is never isWorking', async () => {
    const server = await boot()
    const rows = server.listWorkingSessions()
    const agent = rows.find((entry: any) => entry.sessionId === 'agent-1')
    expect(agent).toMatchObject({ runState: 'running', source: 'coding_agent', runId: 'ar-1' })
  })

  it('lists a live-but-idle coding agent as idle, so the ring can clear', async () => {
    const server = await boot()
    const rows = server.listWorkingSessions()
    const idleAgent = rows.find((entry: any) => entry.sessionId === 'agent-idle')
    expect(idleAgent).toMatchObject({ runState: 'idle' })
  })
})
