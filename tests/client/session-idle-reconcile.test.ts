// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'

/**
 * Regression coverage for the "stuck thinking" deadlock.
 *
 * `isStreaming` is an OR over streamStates / serverWorking / live subagent
 * streams. Clearing only one of them (which switchSession used to do) left the
 * session looking busy forever, so the header kept rendering the thinking
 * indicator AND the next send was classified as live and queued instead of
 * dispatched. These tests pin the convergence guarantees.
 */

const SID = 'session-stuck'

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
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
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
  getBaseUrlValue: vi.fn(() => ''),
  wsOrigin: vi.fn(() => ({ host: '', prefix: '' })),
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

describe('session idle reconciliation', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('exposes a reconciliation helper', () => {
    const store = useChatStore()
    expect(typeof store.reconcileSessionIdle).toBe('function')
  })

  it('clears every source that feeds isStreaming', () => {
    const store = useChatStore()
    store.serverWorking.add(SID)

    store.reconcileSessionIdle(SID)

    // The whole OR must be false afterwards, otherwise the session keeps
    // rendering "thinking" and the next send is queued instead of sent.
    expect(store.serverWorking.has(SID)).toBe(false)
    expect(store.isSessionLive(SID)).toBe(false)
  })

  it('clears per-message streaming flags so the bubble stops spinning', () => {
    const store = useChatStore()
    store.sessions.unshift({
      id: SID,
      profile: 'default',
      title: 'stuck',
      messages: [
        { id: 'm1', role: 'assistant', content: 'partial', timestamp: 1, isStreaming: true },
        { id: 'm2', role: 'user', content: 'hi', timestamp: 2 },
      ],
    } as any)
    store.serverWorking.add(SID)

    store.reconcileSessionIdle(SID)

    const messages = store.sessions.find(s => s.id === SID)?.messages || []
    expect(messages.find(m => m.id === 'm1')?.isStreaming).toBeFalsy()
  })

  it('settles tool rows left mid-flight', () => {
    const store = useChatStore()
    store.sessions.unshift({
      id: SID,
      profile: 'default',
      title: 'stuck',
      messages: [
        { id: 't1', role: 'tool', content: '', timestamp: 1, toolStatus: 'running', toolCallId: 'call-1' },
      ],
    } as any)
    store.serverWorking.add(SID)

    store.reconcileSessionIdle(SID)

    const messages = store.sessions.find(s => s.id === SID)?.messages || []
    expect(messages.find(m => m.id === 't1')?.toolStatus).toBe('done')
  })

  it('is idempotent and safe for unknown or empty sessions', () => {
    const store = useChatStore()
    expect(() => store.reconcileSessionIdle(SID)).not.toThrow()
    expect(() => store.reconcileSessionIdle(SID)).not.toThrow()
    expect(() => store.reconcileSessionIdle('')).not.toThrow()
    expect(() => store.reconcileSessionIdle(undefined)).not.toThrow()
    expect(() => store.reconcileSessionIdle(null)).not.toThrow()
  })

  it('does not treat a session as live after reconciling (send must dispatch, not queue)', () => {
    const store = useChatStore()
    store.serverWorking.add(SID)

    // This is exactly the predicate `sendMessage` uses to decide whether to
    // enqueue the user's message instead of dispatching it.
    expect(store.isSessionLive(SID)).toBe(true)

    store.reconcileSessionIdle(SID)

    expect(store.isSessionLive(SID)).toBe(false)
    expect(store.isSessionWorking(SID)).toBe(false)
  })
})
