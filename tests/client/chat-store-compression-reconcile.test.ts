// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
}))

const sessionsApi = vi.hoisted(() => ({
  fetchWorkingSessions: vi.fn(async () => [] as any[]),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
  getBaseUrlValue: vi.fn(() => ''),
  wsOrigin: vi.fn(() => ({ host: '', prefix: '' })),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  // The 12s poll builds the list from this; an unmocked call would abort it
  // before the working-sessions snapshot (and the compression reconcile).
  fetchSessions: vi.fn(async () => []),
  fetchWorkingSessions: sessionsApi.fetchWorkingSessions,
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

const SID = 'session-1'

function makeSession(id: string = SID): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now() } as Session
}

function stubResume(payload: Record<string, unknown> = {}, sid: string = SID) {
  chatApi.resumeSession.mockImplementation((_sid: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sid, messages: [], isWorking: false, events: [], ...payload })
    return {} as any
  })
}

async function startRun(store: ReturnType<typeof useChatStore>, sid: string = SID) {
  const session = makeSession(sid)
  store.sessions = [session]
  store.activeSessionId = sid
  store.activeSession = session
  await store.sendMessage('hello')
  await nextTick()
  return chatApi.startRunViaSocket.mock.calls.at(-1)![1] as (event: any) => void
}

/**
 * The reported bug: the banner said "Compressing... (187 msgs, ~769.6K tokens)"
 * for 17 minutes after the compression had finished, because the terminal
 * `compression.completed` frame was never applied — the client had switched to
 * another session while the 37s summarization ran.
 */
describe('compression banner reconciliation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.registerSessionHandlers.mockImplementation(() => vi.fn())
    sessionsApi.fetchWorkingSessions.mockResolvedValue([])
    stubResume()
  })

  it('stops claiming a compression is running once its run is over', async () => {
    const store = useChatStore()
    const onEvent = await startRun(store)

    onEvent({ event: 'compression.started', session_id: SID, message_count: 187, token_count: 769_621 })
    expect(store.compressionState).toMatchObject({ compressing: true, messageCount: 187, beforeTokens: 769_621 })

    // The completion frame never arrived (dropped socket / lost run event).
    onEvent({ event: 'run.completed', session_id: SID, run_id: 'run-1' })

    expect(store.compressionState?.compressing).toBe(false)
    // Terminal but unreported: renders as "Compression finished", never as a
    // live compression, and never with invented token numbers.
    expect(store.compressionState?.compressed).toBeNull()
    expect(store.compressionState?.beforeTokens).toBe(769_621)
  })

  it('takes the authoritative snapshot when re-attaching to the session', async () => {
    const store = useChatStore()
    const onEvent = await startRun(store)
    onEvent({ event: 'compression.started', session_id: SID, message_count: 187, token_count: 769_621 })
    expect(store.compressionState?.compressing).toBe(true)

    const startedAt = Date.now() - 11 * 60_000
    stubResume({
      isWorking: false,
      compression: {
        stage: 'completed',
        messageCount: 187,
        beforeTokens: 769_621,
        afterTokens: 45_857,
        compressed: true,
        source: 'run',
        startedAt,
        finishedAt: Date.now(),
      },
    })
    await store.switchSession(SID)

    expect(store.compressionState).toMatchObject({
      compressing: false,
      compressed: true,
      beforeTokens: 769_621,
      afterTokens: 45_857,
      startedAt,
    })
  })

  it('keeps a live run-scoped compression running while the server still reports the run', async () => {
    const store = useChatStore()
    stubResume({
      isWorking: true,
      compression: {
        stage: 'started',
        messageCount: 187,
        beforeTokens: 769_621,
        afterTokens: 0,
        compressed: null,
        source: 'run',
        startedAt: Date.now(),
      },
    })
    store.sessions = [makeSession()]
    await store.switchSession(SID)

    expect(store.compressionState).toMatchObject({ compressing: true, messageCount: 187 })
  })

  it('heals the banner from the periodic working-sessions snapshot', async () => {
    const store = useChatStore()
    stubResume({
      isWorking: true,
      compression: {
        stage: 'started',
        messageCount: 187,
        beforeTokens: 769_621,
        afterTokens: 0,
        compressed: null,
        source: 'run',
        startedAt: Date.now() - 60_000,
      },
    })
    store.sessions = [makeSession()]
    await store.switchSession(SID)
    expect(store.compressionState?.compressing).toBe(true)

    // The poll itself already converged the client's own working flags here, so
    // release them before asking it for the compression snapshot.
    store.serverWorking.delete(SID)
    store.streamStates.delete(SID)
    // The server reports the same session with the compression finished.
    sessionsApi.fetchWorkingSessions.mockResolvedValue([{
      session_id: SID,
      run_started_at: Date.now(),
      compression: {
        stage: 'completed',
        messageCount: 187,
        beforeTokens: 769_621,
        afterTokens: 45_857,
        compressed: true,
        source: 'run',
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now(),
      },
    }])
    await store.refreshSessionListOnly()

    expect(store.compressionState).toMatchObject({ compressing: false, compressed: true, afterTokens: 45_857 })
  })

  it('never claims a run-scoped compression is running for a session the server no longer runs', async () => {
    const store = useChatStore()
    stubResume({
      isWorking: true,
      compression: {
        stage: 'started',
        messageCount: 12,
        beforeTokens: 900_000,
        afterTokens: 0,
        compressed: null,
        source: 'run',
        startedAt: Date.now() - 60_000,
      },
    })
    store.sessions = [makeSession()]
    await store.switchSession(SID)
    expect(store.compressionState?.compressing).toBe(true)

    // The poll only relaxes a session the client is not streaming, the same lag
    // tolerance the working flags use; release the ctrl as a closed socket would.
    store.serverWorking.delete(SID)
    store.streamStates.delete(SID)
    sessionsApi.fetchWorkingSessions.mockResolvedValue([])
    await store.refreshSessionListOnly()

    expect(store.compressionState?.compressing).toBe(false)
    expect(store.compressionState?.compressed).toBeNull()
  })

  it('leaves an idle /compress alone until it reports its own completion', async () => {
    const store = useChatStore()
    const onEvent = await startRun(store)

    onEvent({
      event: 'compression.started',
      session_id: SID,
      source: 'command',
      message_count: 900,
      token_count: 500_000,
    })
    expect(store.compressionState?.compressing).toBe(true)

    // `/compress` runs while the session is idle, so an idle snapshot says
    // nothing about it.
    sessionsApi.fetchWorkingSessions.mockResolvedValue([])
    await store.refreshSessionListOnly()
    expect(store.compressionState?.compressing).toBe(true)

    onEvent({
      event: 'compression.completed',
      session_id: SID,
      source: 'command',
      compressed: true,
      totalMessages: 900,
      beforeTokens: 500_000,
      afterTokens: 90_000,
    })
    expect(store.compressionState).toMatchObject({ compressing: false, compressed: true, afterTokens: 90_000 })
  })
})
