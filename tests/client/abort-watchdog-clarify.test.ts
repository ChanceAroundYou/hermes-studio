// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = 'test' })
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const peers = vi.hoisted(() => [] as Array<(event: unknown) => void>)
vi.mock('@/api/studio/chat', () => ({
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(),
  connectChatRun: vi.fn(), respondClarify: vi.fn(),
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

const STOP_UNCONFIRMED = 'Stop was not confirmed by the run. Press stop again.'

const requested = (clarifyId: string) => ({
  event: 'clarify.requested', session_id: 's1', clarify_id: clarifyId, question: `Q ${clarifyId}`,
  choices: ['a', 'b'], timeout_ms: 5_000, remaining_timeout_ms: 5_000,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  setActivePinia(createPinia())
  peers.length = 0
})

afterEach(() => { vi.useRealTimers() })

/**
 * `Stop was not confirmed by the run. Press stop again.` fired while the server
 * was still legitimately working through the stop, because the run was parked on
 * a question the stop had to settle first. Reporting a live stop as lost is
 * worse than waiting: it told the user to press a button that was already doing
 * the right thing.
 */
describe('the stop watchdog while a question is open', () => {
  it('does not call the stop lost while the run is still parked on a prompt', () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    peers[0](requested('c1'))
    store.abortState = { aborting: true, synced: null }

    vi.advanceTimersByTime(8_000)
    expect(store.abortState?.error).toBeUndefined()
    expect(store.abortState?.aborting).toBe(true)
  })

  it('still reports a lost stop once nothing is left waiting', () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    store.abortState = { aborting: true, synced: null }

    vi.advanceTimersByTime(8_000)
    expect(store.abortState?.error).toBeUndefined()
    vi.advanceTimersByTime(12_000)
    expect(store.abortState?.error).toBe(STOP_UNCONFIRMED)
    expect(store.abortState?.aborting).toBe(false)
  })

  it('does not extend the wait forever', () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    peers[0](requested('c1'))
    store.abortState = { aborting: true, synced: null }

    // Three extra windows are granted while the prompt is still open...
    vi.advanceTimersByTime(60_000)
    expect(store.abortState?.error).toBeUndefined()
    // ...the fourth gives up, so a genuinely lost stop still surfaces.
    vi.advanceTimersByTime(20_000)
    expect(store.abortState?.error).toBe(STOP_UNCONFIRMED)
  })

  it('gives a later stop a full budget again', () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    peers[0](requested('c1'))

    // A first stop spends the whole budget and is then reported as lost.
    store.abortState = { aborting: true, synced: null }
    vi.advanceTimersByTime(80_000)
    expect(store.abortState?.error).toBe(STOP_UNCONFIRMED)

    // A later stop must not inherit the spent budget, or the second stop would
    // be declared lost after a single window instead of four.
    store.abortState = { aborting: true, synced: null }
    vi.advanceTimersByTime(60_000)
    expect(store.abortState?.error).toBeUndefined()
  })

  it('clears the watchdog when the stop lands', () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    peers[0](requested('c1'))
    store.abortState = { aborting: true, synced: null }
    vi.advanceTimersByTime(20_000)
    store.abortState = null
    vi.advanceTimersByTime(80_000)
    expect(store.abortState).toBeNull()
  })
})
