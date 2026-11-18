// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = 'test' })
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(), connectChatRun: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
  ...api,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(), onSessionCommand: vi.fn(),
  onSessionTitleUpdated: vi.fn(), onSessionWorkspaceUpdated: vi.fn(),
  onSessionSettingsUpdated: vi.fn(), onRunUsageUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false, getBaseUrlValue: () => '' }))

const sessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(), fetchWorkingSessions: vi.fn(), fetchPendingInteractions: vi.fn(),
}))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(),
  fetchSessions: sessionsApi.fetchSessions,
  fetchWorkingSessions: sessionsApi.fetchWorkingSessions,
  fetchPendingInteractions: sessionsApi.fetchPendingInteractions,
  fetchSessionMessagesPage: vi.fn(async () => null),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(), setSessionModel: vi.fn(),
}))
vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(), fetchAvailableModels: vi.fn(), addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(), updateDefaultModel: vi.fn(), updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(), updateModelAlias: vi.fn(),
}))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))

import { useChatStore } from '@/stores/hermes/chat'

function listSessions(...ids: string[]) {
  sessionsApi.fetchSessions.mockImplementation(async (source?: string) => (
    source === 'global_agent'
      ? []
      : ids.map(id => ({ id, title: id, profile: 'default', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }))
  ))
}

/** One row of the dedicated pending-interactions snapshot. */
function pendingRow(over: Record<string, unknown> = {}) {
  return {
    scope: 'session', owner_id: 'live', interaction_id: 'c-live', kind: 'clarify',
    status: 'pending', profile: 'default', question: 'Which folder?', choices: ['client', 'server'],
    run_id: 'turn-1', context_id: 'ctx-1', remaining_timeout_ms: 4_000,
    created_at: 1, resolved_at: null, resolved_reason: null,
    ...over,
  }
}

function seedLocalClarify(sessionId: string, clarifyId: string) {
  const store = useChatStore()
  const next = new Map(store.pendingClarifies)
  next.set(`${sessionId}:${clarifyId}`, {
    sessionId, clarifyId, question: 'stale local', choices: null,
    initialResponse: '', responseMode: '', timeoutMs: 300_000, requestedAt: 1, countdownDeadline: 1,
  })
  store.pendingClarifies = next
  return store
}

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  api.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  api.resumeSession.mockImplementation((sid: string, callback: (data: any) => void) => {
    callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })
  })
  listSessions()
  sessionsApi.fetchWorkingSessions.mockResolvedValue([])
  sessionsApi.fetchPendingInteractions.mockResolvedValue([])
})

describe('pending interactions are reconciled from the server snapshot', () => {
  it('adopts what the server reports and drops a card the server no longer has', async () => {
    // The reported bug: a prompt cancelled while the user was in another
    // conversation stayed on screen forever, and clicking it did nothing,
    // because nothing ever withdrew it.
    const store = seedLocalClarify('gone', 'c-gone')
    sessionsApi.fetchPendingInteractions.mockResolvedValue([pendingRow()])

    await store.refreshSessionListOnly()

    expect([...store.pendingClarifies.keys()]).toEqual(['live:c-live'])
    expect(store.pendingClarifies.get('live:c-live')).toMatchObject({
      sessionId: 'live', clarifyId: 'c-live', question: 'Which folder?', choices: ['client', 'server'],
    })
    expect(store.pendingClarifies.get('live:c-live')!.countdownDeadline).toBeGreaterThan(0)
  })

  it('leaves the cards alone when the snapshot cannot be read', async () => {
    // A flaky poll must not blank the screen and lose an answer in progress.
    const store = seedLocalClarify('keep', 'c-keep')
    sessionsApi.fetchPendingInteractions.mockRejectedValue(new Error('network down'))

    await store.refreshSessionListOnly()

    expect([...store.pendingClarifies.keys()]).toEqual(['keep:c-keep'])
    expect(store.pendingClarifies.get('keep:c-keep')!.clarifyId).toBe('c-keep')
  })

  it('re-reads the cards on the run-state tick instead of owning a timer', async () => {
    // D3: the same 3s `working-sessions` tick carries this, so there is exactly
    // one place that asks the server "what is true right now".
    const store = useChatStore()
    await store.refreshSessionListOnly()
    await store.refreshSessionListOnly()

    expect(sessionsApi.fetchPendingInteractions).toHaveBeenCalledTimes(2)
  })

  it('keeps a row the snapshot still lists, without disturbing its countdown', async () => {
    const store = seedLocalClarify('live', 'c-live')
    const before = store.pendingClarifies.get('live:c-live')!.countdownDeadline
    sessionsApi.fetchPendingInteractions.mockResolvedValue([pendingRow()])

    await store.refreshSessionListOnly()

    // Same interaction, so the local entry is kept rather than rebuilt -- a
    // rebuild every tick would restart the visible countdown.
    expect(store.pendingClarifies.get('live:c-live')!.countdownDeadline).toBe(before)
  })

  it('ignores carriers it does not own, instead of half-rendering them', async () => {
    const store = useChatStore()
    sessionsApi.fetchPendingInteractions.mockResolvedValue([
      pendingRow({ scope: 'room', owner_id: 'room-1', interaction_id: 'c-room' }),
      pendingRow({ scope: 'device', owner_id: 'device-1', interaction_id: 'c-device' }),
    ])

    await store.refreshSessionListOnly()

    expect([...store.pendingClarifies.keys()]).toEqual([])
  })
})
