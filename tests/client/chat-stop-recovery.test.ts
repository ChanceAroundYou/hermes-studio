// @vitest-environment jsdom
vi.hoisted(() => { (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = 'test' })
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
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
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

import { useChatStore, ABORT_WATCHDOG_MS, type Message } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'

// The store owns the window; duplicating it here let a change to the real
// watchdog leave this test asserting the old one.
const WATCHDOG_MS = ABORT_WATCHDOG_MS

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

/** How many times the session socket was asked to abort, across every handle. */
function emitAbortOnSessionSocket(): number {
  return chatApi.getChatRunSocket.mock.results.reduce((total, result) => {
    const socket = result.value as { emit: ReturnType<typeof vi.fn> } | undefined
    const emit = socket?.emit as ReturnType<typeof vi.fn> | undefined
    if (!emit) return total
    return total + emit.mock.calls.filter(call => call[0] === 'abort').length
  }, 0)
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

    // The run handle refused, so the stop falls back to the session socket and
    // is still a stop that left this tab: it must not be reported as a failure.
    expect(emitAbortOnSessionSocket()).toBe(1)
    expect(store.abortState?.synced).toBeNull()
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
    // eslint-disable-next-line no-console

    expect(store.isAborting).toBe(false)
    expect(store.abortState?.error).toBeTruthy()

    // And the button works again. The run handle refused, so the second press
    // leaves on the session socket -- that is the recovery, not a second call to
    // a handle that has already proven itself dead.
    // The local handle is already known dead, so the retry goes straight out on
    // the session socket. That count is the assertion: it is the recovery.
    const before = emitAbortOnSessionSocket()
    // eslint-disable-next-line no-console
    store.stopStreaming()
    expect(emitAbortOnSessionSocket()).toBe(before + 1)
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

  // Production stores `abort: () => emitAbortOnSessionSocket(sid)`, but handles built
  // elsewhere return nothing at all. Reading "no return value" as a failure marked a
  // stop that demonstrably left this tab as unconfirmed, and the card flipped to an
  // error the user could not act on.
  it('treats an abort handle with no return value as a stop that left this tab', async () => {
    const emit = vi.fn()
    chatApi.getChatRunSocket.mockReturnValue({ connected: true, emit } as any)
    const store = useChatStore()
    const settings = useSettingsStore()
    settings.display.bell_on_complete = false
    settings.display.approval_bell = false
    const session = makeSession('void-handle-session')
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn(() => true) })
    await store.sendMessage('hello')
    store.streamStates.set(session.id, { abort: () => undefined })

    store.stopStreaming()

    expect(store.isAborting).toBe(true)
    expect(store.abortState?.error).toBeFalsy()
    // The stored handle is preferred over the shared socket.
    expect(emit).not.toHaveBeenCalled()
  })

  // The session ring is lit by isSessionWorking, which also counts a background
  // delegation. Gating the button on the two foreground flags alone left that ring
  // lit with a stop button that returned without emitting anything.
  it('stops a session that is busy only through a background delegation', async () => {
    const emit = vi.fn()
    chatApi.getChatRunSocket.mockReturnValue({ connected: true, emit } as any)
    const store = useChatStore()
    const settings = useSettingsStore()
    settings.display.bell_on_complete = false
    settings.display.approval_bell = false
    const session = makeSession('delegating-session')
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    store.backgroundPendingBySession.set(session.id, 1)

    // The disagreement this guard is about: the ring says busy, the foreground
    // flags say idle.
    expect(store.isSessionWorking(session.id)).toBe(true)
    expect(store.isStreaming).toBe(false)

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