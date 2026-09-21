import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for a leaked `isWorking` on the CLI-bridge path.
 *
 * When a resume claims a session, `activeRunMarker` is replaced, so the
 * original run loop's chunks are classified as stale. Its TERMINAL chunk was
 * dropped along with them, and because the "stream ended without a terminal
 * chunk" fallback required `activeRunMarker === runMarker` — the very field the
 * resume had just overwritten — that safety net could never fire either
 * (0 occurrences in production logs). The session then answered
 * `isWorking: true` on every resume for hours, so clients showed "thinking"
 * forever and queued the user's next message.
 */

const startRunSessionMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: vi.fn(() => 42),
  createSession: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-stale', profile: 'default', model: 'gpt-test', provider: 'openai' })),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionDetailPaginated: vi.fn(() => null),
  updateMessageDisplayContent: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
  getUsage: vi.fn(() => null),
  getRecordedUsageTotals: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  countTokens: vi.fn(() => 1),
  SUMMARY_PREFIX: '[Summary] ',
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async () => {
  const actual = await vi.importActual<any>('../../packages/server/src/modules/studio/services/chat-run/compression')
  return {
    ...actual,
    buildDbHistory: vi.fn(async () => []),
    buildSnapshotAwareHistory: vi.fn(async () => []),
    buildCompressedHistory: vi.fn(async () => ({ messages: [], compressed: false })),
    forceCompressBridgeHistory: vi.fn(),
  }
})

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 1, outputTokens: 1 })),
  contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 1, outputTokens: 1 })),
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-persistence', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

function createNamespace() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    nsp: {
      adapter: { rooms: { get: vi.fn(() => new Set(['socket-1'])) } },
      to: vi.fn(() => ({
        emit: vi.fn((event: string, payload: any) => emitted.push({ event, payload })),
      })),
    },
  }
}

describe('stale CLI bridge chunk handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startRunSessionMock.mockReset()
  })

  it('converges a resumed run whose bridge snapshot is already terminal', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const { nsp, emitted } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }

    // The session is tracked by ANOTHER loop: this resume owns the marker, and
    // the run id it remembers is the one whose loop is now stale.
    const sessionMap = new Map<string, any>()
    sessionMap.set('session-stale', {
      messages: [],
      isWorking: true,
      events: [],
      queue: [],
      runId: 'run-stale',
      activeRunMarker: 'marker-current',
    })

    const bridge = {
      getResult: vi.fn(async () => ({
        ok: true,
        run_id: 'run-stale',
        session_id: 'session-stale',
        status: 'complete',
        output: '',
        deltas: [],
        events: [],
      })),
      // Immediately terminal: the run this loop was resuming already finished.
      getOutput: vi.fn(async () => ({
        ok: true,
        run_id: 'run-stale',
        session_id: 'session-stale',
        status: 'complete',
        delta: '',
        cursor: 0,
        output: '',
        done: true,
        events: [],
        event_cursor: 0,
      })),
      streamOutput: vi.fn(),
    }

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-stale',
        runId: 'run-stale',
        profile: 'default',
        instructions: '',
        source: 'cli',
      },
      sessionMap,
      bridge as any,
      vi.fn(),
    )

    // The leaked flag must be gone: otherwise every resume answers
    // `isWorking: true` and the client can never converge.
    const state = sessionMap.get('session-stale')
    expect(state.isWorking).toBe(false)
    expect(state.runId).toBeUndefined()
  })
})
