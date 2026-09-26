// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
}))

const sessionsApi = vi.hoisted(() => ({
  fetchSessionMessagesPage: vi.fn(),
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
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkingSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: sessionsApi.fetchSessionMessagesPage,
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

async function startRun(store: ReturnType<typeof useChatStore>, session: any) {
  const settings = useSettingsStore()
  settings.display.bell_on_complete = false
  settings.display.approval_bell = false
  store.sessions = [session]
  store.activeSessionId = session.id
  store.activeSession = session
  await store.sendMessage('hello')
  return chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
}

describe('chat run errors render as one persistent bubble', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.registerSessionHandlers.mockImplementation(() => vi.fn())
    chatApi.resumeSession.mockImplementation((_sid: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: _sid, messages: [], isWorking: false, events: [] })
      return {} as any
    })
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue({
      messages: [],
      total: 0,
      hasMore: false,
      taskPlans: [],
      workspaceRunChanges: [],
      session: { id: 'stub', title: 'stub', profile: 'default' },
    })
  })

  it('keeps a client-injected run error when the transcript is re-fetched', async () => {
    const store = useChatStore()
    const session = makeSession('err-refetch')
    const onEvent = await startRun(store, session)

    onEvent({ event: 'run.started', session_id: session.id, run_id: 'run-1' })
    onEvent({
      event: 'run.failed',
      session_id: session.id,
      run_id: 'run-1',
      error: 'Provider returned 429 Too Many Requests',
    })

    const before = session.messages.find((m: Message) => m.systemType === 'error')
    expect(before?.content).toBe('Error: Provider returned 429 Too Many Requests')

    // Tab focus / session switch re-pulls the server transcript, which can
    // never contain a client-only row. The error must survive it.
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue({
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      total: 1,
      hasMore: false,
      taskPlans: [],
      workspaceRunChanges: [],
      session: { id: 'err-refetch', title: 'err-refetch', profile: 'default' },
    })
    await store.refreshActiveSession()

    const after = session.messages.find((m: Message) => m.systemType === 'error')
    expect(after).toBeDefined()
    expect(after?.content).toBe('Error: Provider returned 429 Too Many Requests')
  })

  it('collapses two failures reported back to back into a single bubble', async () => {
    const store = useChatStore()
    const session = makeSession('err-collapse')
    const onEvent = await startRun(store, session)

    onEvent({
      event: 'run.failed',
      session_id: session.id,
      run_id: 'run-1',
      error: 'Unable to confirm Agent Bridge status while resuming: timeout',
    })
    onEvent({
      event: 'run.failed',
      session_id: session.id,
      run_id: 'run-1',
      error: 'Provider returned 429 Too Many Requests',
    })

    const errors = session.messages.filter((m: Message) => m.role === 'assistant' && m.systemType === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].content).toBe('Error: Provider returned 429 Too Many Requests')
  })

  it('does not duplicate an identical repeated failure', async () => {
    const store = useChatStore()
    const session = makeSession('err-dedupe')
    const onEvent = await startRun(store, session)

    const failure = { event: 'run.failed', session_id: session.id, run_id: 'run-1', error: 'Boom' }
    onEvent(failure)
    onEvent(failure)

    const errors = session.messages.filter((m: Message) => m.role === 'assistant' && m.systemType === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].content).toBe('Error: Boom')
  })

  it('renders a bridge resume failure with the error bubble, not a system notice', async () => {
    const store = useChatStore()
    const session = makeSession('err-reattach')
    const onEvent = await startRun(store, session)

    onEvent({
      event: 'run.reattach_failed',
      session_id: session.id,
      text: 'Unable to confirm Agent Bridge status while resuming: timeout',
    })

    const errors = session.messages.filter((m: Message) => m.role === 'assistant' && m.systemType === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].localOnly).toBe(true)
    expect(String(errors[0].content)).toContain('Unable to confirm Agent Bridge status while resuming')
    expect(
      session.messages.some((m: Message) =>
        m.role === 'system' && !m.commandAction && String(m.content || '').includes('Unable to confirm'),
      ),
    ).toBe(false)
  })

  it('restores a persisted run error after a reload', async () => {
    const first = useChatStore()
    const session = makeSession('err-reload')
    const onEvent = await startRun(first, session)

    onEvent({ event: 'run.failed', session_id: session.id, run_id: 'run-1', error: 'Provider returned 502' })
    expect(session.messages.some((m: Message) => m.systemType === 'error')).toBe(true)

    // Simulate a page reload: a brand new store whose transcript comes only
    // from the server, which never stored the client-side error row.
    setActivePinia(createPinia())
    const second = useChatStore()
    const reloaded = makeSession('err-reload')
    second.sessions = [reloaded]
    second.activeSessionId = reloaded.id
    second.activeSession = reloaded
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue({
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      total: 1,
      hasMore: false,
      taskPlans: [],
      workspaceRunChanges: [],
      session: { id: 'err-reload', title: 'err-reload', profile: 'default' },
    })
    await second.switchSession('err-reload')

    const restored = (second.sessions[0].messages || []).find((m: Message) => m.systemType === 'error')
    expect(restored).toBeDefined()
    expect(restored?.content).toBe('Error: Provider returned 502')
  })

  it('tags every injected error as local-only so re-mapping can preserve it', async () => {
    const store = useChatStore()
    const session = makeSession('err-local-only')
    const onEvent = await startRun(store, session)

    onEvent({ event: 'run.failed', session_id: session.id, run_id: 'run-1', error: 'Oops' })

    const error = session.messages.find((m: Message) => m.systemType === 'error')
    expect(error).toMatchObject({ role: 'assistant', systemType: 'error', localOnly: true })
  })
})
