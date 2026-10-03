// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
}))

vi.mock('@/api/studio/chat', () => ({
  connectChatRun: vi.fn(),
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onApprovalRequested: vi.fn(() => vi.fn()),
  onApprovalResolved: vi.fn(() => vi.fn()),
  onClarifyRequested: vi.fn(() => vi.fn()),
  onClarifyResolved: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkingSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
  getBaseUrlValue: vi.fn(() => ''),
  wsOrigin: vi.fn(() => ({ host: '', prefix: '' })),
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
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Message } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'

const WATCHDOG_MS = 8000

function makeSession(id: string) {
  return {
    id,
    title: id,
    profile: 'default',
    messages: [] as Message[],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any
}

async function startRun(abort: () => unknown) {
  const store = useChatStore()
  const settings = useSettingsStore()
  settings.display.bell_on_complete = false
  settings.display.approval_bell = false
  chatApi.startRunViaSocket.mockReturnValue({ abort })
  const session = makeSession('stop-session')
  store.sessions = [session]
  store.activeSessionId = session.id
  store.activeSession = session
  await store.sendMessage('hello')
  return store
}

describe('the stop button always recovers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    chatApi.registerSessionHandlers.mockImplementation(() => vi.fn())
    chatApi.resumeSession.mockImplementation((_sid: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: _sid, messages: [], isWorking: false, events: [] })
      return {} as any
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never claims the run is pausing when the request was never sent', async () => {
    // A run handle that refuses means the socket was already gone: the old code
    // still painted "Pausing..." and then refused every later press.
    const store = await startRun(() => false)

    store.stopStreaming()

    expect(store.isAborting).toBe(false)
    expect(store.abortState?.error).toBeTruthy()
    expect(store.abortState?.synced).toBe(false)
  })

  it('unlocks the stop button when the run never confirms the stop', async () => {
    vi.useFakeTimers()
    const abort = vi.fn(() => true)
    const store = await startRun(abort)

    store.stopStreaming()
    expect(store.isAborting).toBe(true)

    // Nothing ever confirms: the watchdog has to let go on its own.
    vi.advanceTimersByTime(WATCHDOG_MS)
    await Promise.resolve()

    expect(store.isAborting).toBe(false)
    expect(store.abortState?.error).toBeTruthy()

    // And the button works again.
    store.stopStreaming()
    expect(abort).toHaveBeenCalledTimes(2)
    expect(store.isAborting).toBe(true)
  })

  it('leaves a confirmed stop alone', async () => {
    vi.useFakeTimers()
    const abort = vi.fn(() => true)
    const store = await startRun(abort)
    // The run stream callback is how the server delivers abort.* to this store.
    const emitEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    store.stopStreaming()
    expect(store.isAborting).toBe(true)

    emitEvent({ event: 'abort.completed', session_id: 'stop-session', run_id: 'r1', synced: true })
    expect(store.isAborting).toBe(false)
    // A confirmed run clears the panel outright.
    expect(store.abortState).toBeNull()

    // The watchdog must not resurrect a finished session as a failure.
    vi.advanceTimersByTime(WATCHDOG_MS * 2)
    await Promise.resolve()
    expect(store.abortState).toBeNull()
    expect(store.isAborting).toBe(false)
  })

  it('falls back to the session socket when the run handle is gone', async () => {
    const emit = vi.fn()
    chatApi.getChatRunSocket.mockReturnValue({ connected: true, emit } as any)
    const store = useChatStore()
    const settings = useSettingsStore()
    settings.display.bell_on_complete = false
    settings.display.approval_bell = false
    const session = makeSession('socket-session')
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    // No run handle for this session, but the server still reports it working.
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn(() => true) })
    await store.sendMessage('hello')
    ;(store as any).serverWorking.add(session.id)
    // No run handle left for this session -- only the shared session socket.
    ;(store as any).streamStates.delete(session.id)
    emit.mockClear()

    store.stopStreaming()

    expect(emit).toHaveBeenCalledWith('abort', { session_id: session.id })
    expect(store.isAborting).toBe(true)
  })

  it('reports a dead socket instead of waiting on a stop that cannot leave', async () => {
    chatApi.getChatRunSocket.mockReturnValue(null)
    const store = useChatStore()
    const settings = useSettingsStore()
    settings.display.bell_on_complete = false
    settings.display.approval_bell = false
    const session = makeSession('dead-session')
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn(() => true) })
    await store.sendMessage('hello')
    ;(store as any).serverWorking.add(session.id)
    ;(store as any).streamStates.delete(session.id)

    store.stopStreaming()

    expect(store.isAborting).toBe(false)
    expect(store.abortState?.error).toBeTruthy()
  })
})