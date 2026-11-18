// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = 'test' })
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

/** The peer handler the store registers is the real path a prompt arrives on. */
const peers = vi.hoisted(() => [] as Array<(event: unknown) => void>)
const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(),
  connectChatRun: vi.fn(), respondClarify: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
  ...api,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  onPeerUserMessage: (handler: (event: unknown) => void) => { peers.push(handler) },
  onSessionCommand: vi.fn(), onSessionTitleUpdated: vi.fn(),
  onSessionWorkspaceUpdated: vi.fn(), onSessionSettingsUpdated: vi.fn(), onRunUsageUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false, getBaseUrlValue: () => '' }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(),
  fetchSessions: vi.fn(async () => []),
  fetchWorkingSessions: vi.fn(async () => []),
  fetchPendingInteractions: vi.fn(async () => []),
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

const requested = (clarifyId: string) => ({
  event: 'clarify.requested', session_id: 's1', clarify_id: clarifyId, question: `Q ${clarifyId}`,
  choices: ['a', 'b'], timeout_ms: 5_000, remaining_timeout_ms: 5_000,
})
const resolved = (clarifyId: string) => ({
  event: 'clarify.resolved', session_id: 's1', clarify_id: clarifyId, resolved: true, reason: 'response',
})

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  peers.length = 0
})

describe('a session can wait on more than one question', () => {
  it('keeps both prompts instead of overwriting the first', () => {
    // The map was keyed by session alone, so the second question silently
    // replaced the first and the turn that asked it was never answered.
    const store = useChatStore()
    peers[0](requested('c1'))
    peers[0](requested('c2'))

    expect([...store.pendingClarifies.keys()].sort()).toEqual(['s1:c1', 's1:c2'])
    expect(store.pendingClarifies.get('s1:c1')!.question).toBe('Q c1')
    expect(store.pendingClarifies.get('s1:c2')!.question).toBe('Q c2')
  })

  it('lists every open prompt for the session on screen', () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    peers[0](requested('c1'))
    peers[0](requested('c2'))

    expect(store.activePendingClarifies.map(pending => pending.clarifyId)).toEqual(['c1', 'c2'])
    // The single-value accessor survives for the surfaces that show one card.
    expect(store.activePendingClarify!.clarifyId).toBe('c1')

    store.activeSessionId = 'other'
    expect(store.activePendingClarifies).toEqual([])
    expect(store.activePendingClarify).toBeNull()
  })

  it('withdraws only the prompt that was answered', () => {
    const store = useChatStore()
    peers[0](requested('c1'))
    peers[0](requested('c2'))

    expect(store.respondToClarifyFor('s1', 'c1', 'a')).toBe('submitted')
    expect(api.respondClarify).toHaveBeenCalledWith('s1', 'c1', 'a', expect.anything())

    peers[0](resolved('c1'))
    expect([...store.pendingClarifies.keys()]).toEqual(['s1:c2'])
    expect(store.pendingClarifies.get('s1:c2')!.question).toBe('Q c2')
  })

  it('does not let one id answer or clear another', () => {
    const store = useChatStore()
    peers[0](requested('c1'))

    expect(store.respondToClarifyFor('s1', 'c2', 'a')).toBe('missing')
    expect(api.respondClarify).not.toHaveBeenCalled()

    // A resolve for an id nobody holds must not take the open one with it.
    peers[0](resolved('c9'))
    expect(store.pendingClarifies.has('s1:c1')).toBe(true)
  })

})

describe('a prompt the server settled goes away, however it ended', () => {
  it('clears the card when the turn was cancelled, not only when it expired', () => {
    const store = useChatStore()
    peers[0](requested('c1'))

    // The agent run names why it stopped. Only expiry-shaped reasons used to be
    // honoured, so a cancelled prompt stayed on screen for good: gone from the
    // server, so the card looked answerable and quietly dropped the click.
    peers[0]({ event: 'clarify.resolved', session_id: 's1', clarify_id: 'c1', resolved: false, reason: 'cancelled' })

    expect(store.pendingClarifies.has('s1:c1')).toBe(false)
  })

  it('clears it when the run was interrupted', () => {
    const store = useChatStore()
    peers[0](requested('c1'))
    peers[0]({ event: 'clarify.resolved', session_id: 's1', clarify_id: 'c1', resolved: false, reason: 'aborted' })
    expect(store.pendingClarifies.has('s1:c1')).toBe(false)
  })

  it('clears it when the server merely dismissed it', () => {
    const store = useChatStore()
    peers[0](requested('c1'))
    peers[0]({ event: 'clarify.resolved', session_id: 's1', clarify_id: 'c1', resolved: false, reason: 'dismissed' })
    expect(store.pendingClarifies.has('s1:c1')).toBe(false)
  })

  it('keeps the card when the answer itself was refused, so it can be retried', () => {
    const store = useChatStore()
    peers[0](requested('c1'))

    // No settlement reason, only an error: the submission did not land, and the
    // prompt is still open.
    peers[0]({
      event: 'clarify.resolved', session_id: 's1', clarify_id: 'c1',
      resolved: false, error: 'Clarification could not be applied.',
    })

    expect(store.pendingClarifies.has('s1:c1')).toBe(true)
  })

  it('keeps the card when the refusal carries no recognisable settlement reason', () => {
    const store = useChatStore()
    peers[0](requested('c1'))

    // `resolved: false` with a reason we do not recognise is not a settlement we
    // can act on, so the conservative reading is that the prompt is still open.
    peers[0]({ event: 'clarify.resolved', session_id: 's1', clarify_id: 'c1', resolved: false, reason: 'who knows' })

    expect(store.pendingClarifies.has('s1:c1')).toBe(true)
  })
})
