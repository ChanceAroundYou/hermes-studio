// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'
import { startRunViaSocket } from '@/api/studio/chat'
import { archiveSession, fetchSessions } from '@/api/studio/sessions'

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn((_sessionId: string, cb: (data: any) => void) => {
    cb({ session_id: _sessionId, isWorking: false, messages: [] })
  }),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  showCompletionNotification: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

function makeSession(id: string, times: Partial<{ started_at: number; ended_at: number | null; last_active: number }>) {
  return {
    id,
    profile: 'default',
    source: 'cli',
    title: id,
    preview: '',
    started_at: times.started_at ?? 1,
    ended_at: times.ended_at ?? null,
    last_active: times.last_active,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: 'gpt-test',
    provider: 'test',
  }
}

describe('chat session ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('orders sessions by last message time, never by when a run ended', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('ended-late-but-stale', { started_at: 100, last_active: 900, ended_at: 5000 }),
        makeSession('newer-last-message', { started_at: 1000, last_active: 2000, ended_at: 2000 }),
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    await store.loadSessions()

    // `ended_at` (5000) is far later than the other session's last message
    // (2000). Sorting by it would put `ended-late-but-stale` first, which is
    // exactly the bug this replaces: a session whose finalization ran long
    // after its last message outranked a genuinely more recent transcript.
    expect(store.sessions.map(session => session.id)).toEqual([
      'newer-last-message',
      'ended-late-but-stale',
    ])
    expect(store.sessions[0].updatedAt).toBe(2000_000)
  })

  it('falls back to started_at for a session that has no messages yet', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('has-messages', { started_at: 100, last_active: 900 }),
        makeSession('brand-new', { started_at: 5000, last_active: 0 }),
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual(['brand-new', 'has-messages'])
  })

  it('removes an archived session from the runtime session list', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('active-session', { started_at: 1000, last_active: 1000 }),
        makeSession('archive-me', { started_at: 900, last_active: 900 }),
      ] as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeSession('active-session', { started_at: 1000, last_active: 1000 }),
      ] as any)
      .mockResolvedValueOnce([])
    vi.mocked(archiveSession).mockResolvedValueOnce(true)

    const store = useChatStore()
    await store.loadSessions()
    const ok = await store.archiveSession('archive-me')

    expect(ok).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('archive-me')
    expect(store.sessions.map(session => session.id)).toEqual(['active-session'])
  })

  it('clears the active session when archiving the only runtime session', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('archive-me', { started_at: 1000, last_active: 1000 }),
      ] as any)
      .mockResolvedValueOnce([])
    vi.mocked(archiveSession).mockResolvedValueOnce(true)

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSessionId).toBe('archive-me')

    const ok = await store.archiveSession('archive-me')

    expect(ok).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('archive-me')
    expect(store.sessions).toEqual([])
    expect(store.activeSessionId).toBeNull()
    expect(store.activeSession).toBeNull()
  })

  it('ignores a stale session-list response after a newer route load completes', async () => {
    const pending: Array<(sessions: any[]) => void> = []
    vi.mocked(fetchSessions).mockImplementation(() => new Promise(resolve => pending.push(resolve)))

    const store = useChatStore()
    const first = store.loadSessions(null, 'session-a')
    const second = store.loadSessions(null, 'session-b')

    pending[2]([makeSession('session-b', { started_at: 2000, last_active: 2000 })])
    pending[3]([])
    await second

    pending[0]([makeSession('session-a', { started_at: 1000, last_active: 1000 })])
    pending[1]([])
    await first

    expect(store.sessions.map(session => session.id)).toEqual(['session-b'])
    expect(store.activeSessionId).toBe('session-b')
    expect(store.activeSession?.id).toBe('session-b')
  })

  it('does not let an in-flight session load replace a newly created chat', async () => {
    const pending: Array<(sessions: any[]) => void> = []
    vi.mocked(fetchSessions).mockImplementation(() => new Promise(resolve => pending.push(resolve)))

    const store = useChatStore()
    const load = store.loadSessions(null, 'session-a')
    const newSession = store.newChat()

    expect(store.activeSessionId).toBe(newSession.id)

    pending[0]([makeSession('session-a', { started_at: 1000, last_active: 1000 })])
    pending[1]([])
    await load

    expect(store.sessions.map(session => session.id)).toEqual([newSession.id, 'session-a'])
    expect(store.activeSessionId).toBe(newSession.id)
    expect(store.activeSession?.id).toBe(newSession.id)

    await store.sendMessage('first message')
    expect(startRunViaSocket).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: newSession.id }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Object),
    )
  })

  it('does not retain a local-only chat outside the requested profile', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        { ...makeSession('research-session', { started_at: 1000 }), profile: 'research' },
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    const localSession = store.newChat({ profile: 'default' })

    await store.loadSessions('research')

    expect(store.sessions.map(session => session.id)).toEqual(['research-session'])
    expect(store.sessions.some(session => session.id === localSession.id)).toBe(false)
    expect(store.activeSessionId).toBe('research-session')
  })

  it('rebinds the active session after a stale list refresh during an explicit switch', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('session-a', { started_at: 2000 }),
        makeSession('session-b', { started_at: 1000 }),
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    await store.loadSessions()

    const pending: Array<(sessions: any[]) => void> = []
    vi.mocked(fetchSessions).mockImplementation(() => new Promise(resolve => pending.push(resolve)))

    const load = store.loadSessions(null, 'session-a')
    await store.switchSession('session-b')

    pending[0]([
      makeSession('session-a', { started_at: 2000 }),
      makeSession('session-b', { started_at: 1000 }),
    ])
    pending[1]([])
    await load

    expect(store.activeSessionId).toBe('session-b')
    expect(store.activeSession).toBe(store.sessions.find(session => session.id === 'session-b'))
  })
})
