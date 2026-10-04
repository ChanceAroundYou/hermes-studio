import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const saveTaskPlanMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/repositories/task-plan-store', () => ({ saveTaskPlan: saveTaskPlanMock }))

const getSessionMock = vi.hoisted(() => vi.fn())
const createSessionMock = vi.hoisted(() => vi.fn())
const addMessageMock = vi.hoisted(() => vi.fn())
const addMessagesMock = vi.hoisted(() => vi.fn())
const updateMessageDisplayContentMock = vi.hoisted(() => vi.fn(() => true))
const updateSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const resolveBridgeRunModelConfigMock = vi.hoisted(() => vi.fn())
const resolveEkkoProviderRuntimeConfigMock = vi.hoisted(() => vi.fn())
const resolveModelProviderConfigsMock = vi.hoisted(() => vi.fn())
const agentRunMock = vi.hoisted(() => vi.fn())
const agentEstimateContextMock = vi.hoisted(() => vi.fn(async () => ({ contextTokens: 5_000 })))
const agentSessionWorkspaceDirectoryMock = vi.hoisted(() => (
  vi.fn((sessionId: string) => `/tmp/ekko-workspace/default/${sessionId}`)
))
const getGlobalEkkoAgentMock = vi.hoisted(() => vi.fn(() => ({
  run: agentRunMock,
  estimateContext: agentEstimateContextMock,
  sessionWorkspaceDirectory: agentSessionWorkspaceDirectoryMock,
})))
const buildCompressedHistoryMock = vi.hoisted(() => vi.fn())
const recordSessionUsageMock = vi.hoisted(() => vi.fn())
const startWorkspaceRunCheckpointMock = vi.hoisted(() => vi.fn())
const completeWorkspaceRunCheckpointMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  addMessages: addMessagesMock,
  updateMessageDisplayContent: updateMessageDisplayContentMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-run', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
  resolveEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
}))

vi.mock('../../packages/server/src/modules/ekko/services/model-config', () => ({
  resolveModelProviderConfigs: resolveModelProviderConfigsMock,
}))

vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  getGlobalEkkoAgent: getGlobalEkkoAgentMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/context-compression', () => ({
  buildCompressedHistory: buildCompressedHistoryMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({
  recordSessionUsage: recordSessionUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/run-state', () => ({
  startWorkspaceRunCheckpoint: startWorkspaceRunCheckpointMock,
  completeWorkspaceRunCheckpoint: completeWorkspaceRunCheckpointMock,
  applyResponseStreamEvent: vi.fn(),
  calcAndUpdateUsage: vi.fn(),
  flushResponseRunToDb: vi.fn(),
  updateContextTokenUsage: vi.fn(),
  getChatRunServer: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', async () => {
  const approvals = await import('../../packages/server/src/modules/ekko/services/approvals')
  const clarifications = await import('../../packages/server/src/modules/ekko/services/clarifications')
  const reasoning = await import('../../packages/ekko-agent/src/model/messages')
  return {
    createChatEkkoAuthorizedProviderFetch: vi.fn(() => vi.fn()),
    getChatEkkoAgent: getGlobalEkkoAgentMock,
    resolveChatEkkoMcpServers: vi.fn(() => undefined),
    resolveChatEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
    createChatEkkoModelClient: vi.fn(() => ({
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
    })),
    resolveChatEkkoModelProviderConfigs: resolveModelProviderConfigsMock,
    getChatEkkoModelRequestTimeoutMs: vi.fn(() => 300_000),
    waitForChatEkkoToolApproval: approvals.waitForEkkoToolApproval,
    waitForChatEkkoClarification: clarifications.waitForEkkoClarification,
    chatEkkoAgentReasoningText: reasoning.agentReasoningText,
    normalizeChatEkkoAgentReasoning: reasoning.normalizeAgentReasoning,
    serializeChatEkkoAgentReasoningDetails: reasoning.serializeAgentReasoningDetails,
  }
})

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
}))

vi.mock('../../packages/server/src/modules/studio/public/pet-events', () => ({
  observeRunChatPetEvent: vi.fn(),
}))

/** A real file, because imageBlockToDataUri reads it and returns null on failure. */
const TMP_DIR = mkdtempSync(join(tmpdir(), 'vision-strip-'))
const IMAGE_PATH = join(TMP_DIR, 'shot.png')
// 1x1 PNG. Contents do not matter; only that the bytes are readable.
writeFileSync(IMAGE_PATH, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
))

function imageBlocks(text: string) {
  return JSON.stringify([
    { type: 'text', text },
    { type: 'image', name: 'shot.png', path: IMAGE_PATH, media_type: 'image/png' },
  ])
}

function imagePartsOf(messages: any[]): any[] {
  return messages.flatMap((message: any) => message?.contentParts || [])
}

function makeHarness() {
  const events: Array<{ event: string; payload: any }> = []
  const roomTarget = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => roomTarget),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
    to: vi.fn(() => roomTarget),
  }
  const sessionMap = new Map<string, any>()
  sessionMap.set('session-1', {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
    inputTokens: 10,
    outputTokens: 5,
  })
  return { events, nsp, socket, sessionMap }
}

const VISION_ERROR =
  'Provider returned 400 Bad Request: {"error":{"code":"vision_disabled","message":"Vision is disabled for this server","param":"messages","type":"invalid_request_error"}}'

describe('a turn survives a model that refuses images', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'ekko-agent',
      model: 'ekko-test-model',
      provider: 'test-provider',
      workspace: '/tmp/workspace',
    })
    addMessageMock.mockReturnValue(1)
    addMessagesMock.mockImplementation((messages: unknown[]) => messages.map((_, index) => 100 + index))
    buildCompressedHistoryMock.mockResolvedValue([])
    recordSessionUsageMock.mockReturnValue(undefined)
    startWorkspaceRunCheckpointMock.mockReturnValue(null)
    completeWorkspaceRunCheckpointMock.mockReturnValue(null)
    resolveBridgeRunModelConfigMock.mockResolvedValue({
      model: 'ekko-test-model',
      provider: 'test-provider',
      apiMode: 'chat_completions',
    })
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValue({ providerConfig: {} })
    resolveModelProviderConfigsMock.mockReturnValue({
      providerConfig: { provider: 'test', model: 'ekko-test-model', apiMode: 'chat_completions' },
    })
  })

  it('retries once without images and still answers', async () => {
    // A historical attachment plus the one just sent: both become image parts.
    buildCompressedHistoryMock.mockResolvedValue([
      { role: 'user', content: imageBlocks('an old screenshot'), timestamp: 1 },
    ])
    agentRunMock.mockRejectedValueOnce(new Error(VISION_ERROR))
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-vision',
      output: { role: 'assistant', content: 'answered without the image' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })

    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: imageBlocks('what is in this?'),
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => { events.push({ event, payload }) },
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledTimes(2)

    const first = agentRunMock.mock.calls[0][0].messages
    expect(imagePartsOf(first).length).toBeGreaterThan(0)

    const second = agentRunMock.mock.calls[1][0].messages
    expect(imagePartsOf(second)).toEqual([])

    // The turn has to survive and actually deliver the answer.
    const completed = events.filter((row: any) => row.event === 'run.completed')
    expect(completed.length).toBeGreaterThan(0)
    expect(JSON.stringify(completed)).toContain('answered without the image')
  })

  it('keeps the text placeholder that names the image', async () => {
    buildCompressedHistoryMock.mockResolvedValue([
      { role: 'user', content: imageBlocks('an old screenshot'), timestamp: 1 },
    ])
    agentRunMock.mockRejectedValueOnce(new Error(VISION_ERROR))
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-vision',
      output: { role: 'assistant', content: 'ok' },
      steps: [], messages: [], events: [],
      contextEstimate: { contextTokens: 5_000 },
    })

    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: imageBlocks('what is in this?'),
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => { events.push({ event, payload }) },
    }, 'default', sessionMap, vi.fn(() => false))

    // Dropping the bytes must not erase the fact that a file was attached, or a
    // text-only model cannot go read it with a tool.
    const second = agentRunMock.mock.calls[1][0].messages as any[]
    const text = second.map((message: any) => String(message?.content || '')).join('\n')
    expect(text).toContain('shot.png')
    expect(text).toContain(IMAGE_PATH)
  })

  it('does not retry an unrelated failure', async () => {
    agentRunMock.mockRejectedValue(new Error('Provider returned 500: upstream exploded'))

    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: imageBlocks('what is in this?'),
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => { events.push({ event, payload }) },
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledTimes(1)
    expect(events.some((row: any) => row.event === 'run.failed')).toBe(true)
  })

  it('does not retry a turn with no images in it', async () => {
    agentRunMock.mockRejectedValue(new Error(VISION_ERROR))

    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'no attachments here',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => { events.push({ event, payload }) },
    }, 'default', sessionMap, vi.fn(() => false))

    // Stripping would change nothing, so a second request is pure waste.
    expect(agentRunMock).toHaveBeenCalledTimes(1)
    expect(events.some((row: any) => row.event === 'run.failed')).toBe(true)
  })
})