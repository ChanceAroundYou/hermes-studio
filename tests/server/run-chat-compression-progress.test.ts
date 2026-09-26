import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailMock = vi.fn()
const getSessionMock = vi.fn()
const getSessionContextMessagesMock = vi.fn()
const getSessionContextMessageMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const getModelContextLengthMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateMessageContextTokenUsageMock = vi.fn()
const compressorCompressMock = vi.fn()
const compressorConstructorMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionDetail: getSessionDetailMock,
  getSession: getSessionMock,
  getSessionContextMessages: getSessionContextMessagesMock,
  getSessionContextMessage: getSessionContextMessageMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    constructor(opts?: any) {
      compressorConstructorMock(opts)
    }
    compress = compressorCompressMock
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-format', () => ({
  isAssistantMessageSendable: vi.fn(() => true),
}))

const COMPRESSION_MODULE = '../../packages/server/src/modules/studio/services/chat-run/compression'

type ProgressState = {
  messages: unknown[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  compression?: any
}

function newState(): ProgressState {
  return { messages: [], isWorking: true, events: [] }
}

/**
 * The reported bug had two halves. The banner was stuck because
 * `compression.completed` is a single fire-and-forget socket event; the events
 * ring it is replayed from was a "latest state" list that mixed two orderings
 * (a `started` was *appended*, a `completed` *replaced in place*), so a stale
 * start could outlive its own completion. These tests pin the authoritative
 * snapshot and the ring ordering.
 */
describe('compression progress snapshot', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    getSessionDetailMock.mockReset()
    getSessionContextMessagesMock.mockReset()
    getSessionContextMessageMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    getModelContextLengthMock.mockReset()
    calcAndUpdateUsageMock.mockReset()
    estimateUsageTokensFromMessagesMock.mockReset()
    updateMessageContextTokenUsageMock.mockReset()
    compressorCompressMock.mockReset()
    compressorConstructorMock.mockReset()
    readConfigYamlForProfileMock.mockReset()

    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', history_revision: 0, model: 'm', provider: 'p' })
    getSessionDetailMock.mockReturnValue({ messages: [] })
    getSessionContextMessagesMock.mockReturnValue([])
    getSessionContextMessageMock.mockReturnValue(null)
    getModelContextLengthMock.mockReturnValue(256_000)
    getCompressionSnapshotMock.mockReturnValue(null)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 0, outputTokens: 0 })
    readConfigYamlForProfileMock.mockResolvedValue({})
  })

  async function runCompression(state: ProgressState, sessionMap: Map<string, any>, emit = vi.fn()) {
    const { compressHistory } = await import(COMPRESSION_MODULE)
    return compressHistory(
      [{ role: 'user', content: 'hello' }],
      null,
      'session-1',
      'http://upstream',
      undefined,
      state as any,
      160_000,
      emit,
      sessionMap as any,
      { model: 'm', provider: 'p', allowHermesFallback: false },
    )
  }

  it('records the in-flight snapshot, then the terminal one', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    compressorCompressMock.mockImplementation(async () => {
      await gate
      return {
        messages: [{ role: 'user', content: 'summary' }],
        meta: { compressed: true, llmCompressed: true, totalMessages: 9, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0 },
      }
    })

    const state = newState()
    const sessionMap = new Map([['session-1', state]])
    const pending = runCompression(state, sessionMap)
    // The started snapshot is written before the summarizer is awaited, but the
    // dynamic import inside runCompression has to settle first — wait for the
    // fact rather than guessing a tick count.
    for (let i = 0; i < 50 && !state.compression; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(state.compression).toMatchObject({
      stage: 'started',
      beforeTokens: 160_000,
      afterTokens: 0,
      compressed: null,
      startedAt: expect.any(Number),
    })

    release()
    await pending

    expect(state.compression).toMatchObject({ stage: 'completed', compressed: true, beforeTokens: 160_000 })
    expect(state.compression.finishedAt).toBeGreaterThanOrEqual(state.compression.startedAt)
  })

  it('keeps the replayed start before the completion across repeated compressions', async () => {
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'summary' }],
      meta: { compressed: true, llmCompressed: true, totalMessages: 9, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0 },
    })

    const state = newState()
    const sessionMap = new Map([['session-1', state]])
    await runCompression(state, sessionMap)
    await runCompression(state, sessionMap)

    const compressionEvents = state.events.filter(entry => entry.event.startsWith('compression.'))
    // Exactly one start and one completion: appending would let a stale start
    // sit after the completion, and an attach would replay it last.
    expect(compressionEvents.map(entry => entry.event)).toEqual(['compression.started', 'compression.completed'])
    expect(state.compression.stage).toBe('completed')
  })

  it('records a failure as a terminal snapshot too', async () => {
    compressorCompressMock.mockRejectedValue(new Error('summarizer exploded'))

    const state = newState()
    const sessionMap = new Map([['session-1', state]])
    const history = await runCompression(state, sessionMap)

    expect(history).toEqual([{ role: 'user', content: 'hello' }])
    expect(state.compression).toMatchObject({ stage: 'completed', compressed: false, error: 'summarizer exploded' })
    expect(state.events.at(-1)?.event).toBe('compression.completed')
  })

  it('carries the compression start time so the transcript entry can be placed', async () => {
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'summary' }],
      meta: { compressed: true, llmCompressed: true, totalMessages: 9, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0 },
    })

    const state = newState()
    const sessionMap = new Map([['session-1', state]])
    const emit = vi.fn()
    const before = Date.now()
    await runCompression(state, sessionMap, emit)

    const startedEvent = emit.mock.calls.find(([event]) => event === 'compression.started')?.[1]
    expect(startedEvent.started_at).toBeGreaterThanOrEqual(before)
    expect(state.compression.startedAt).toBe(startedEvent.started_at)
  })
})
