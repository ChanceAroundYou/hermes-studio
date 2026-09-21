// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'

/**
 * Verifies the SHIPPED client build contains the convergence fix.
 *
 * The production client bundle is property-mangled, so grepping dist for
 * `reconcileSessionIdle` proves nothing (every pre-existing store name greps to
 * 0 as well). This asserts the behaviour the bundle must exhibit instead:
 * a single call must clear every source that feeds `isStreaming`, so a finished
 * run stops looking busy and the next send is dispatched rather than queued.
 */

const SID = 'verify-shipped-build'

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
  getDownloadUrl: (_p: string, n: string) => `/download/${n}`,
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

describe('shipped build convergence guarantees', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('a finished run stops being "live" after one reconciliation', () => {
    const store = useChatStore()
    store.serverWorking.add(SID)
    expect(store.isSessionLive(SID)).toBe(true)

    store.reconcileSessionIdle(SID)

    expect(store.isSessionLive(SID)).toBe(false)
    expect(store.isSessionWorking(SID)).toBe(false)
  })

  it('reconciliation clears the run timer so the elapsed clock stops', () => {
    const store = useChatStore()
    // `runStartedAt` is the exported ref the elapsed timer reads; seeding it
    // directly mirrors a run that was started and then lost its terminal event.
    store.runStartedAt.set(SID, Date.now())
    expect(store.runStartedAt.get(SID)).toBeGreaterThan(0)

    store.reconcileSessionIdle(SID)

    expect(store.runStartedAt.get(SID)).toBeUndefined()
  })

  it('reconciliation clears the active-session abort flag', () => {
    const store = useChatStore()
    store.serverWorking.add(SID)
    store.activeSessionId = SID

    store.reconcileSessionIdle(SID)

    // `abortState` is the exported view of the per-session abort map; a leaked
    // aborting flag keeps the indicator up even after the run ended.
    expect(store.abortState).toBeNull()
    expect(store.isAborting).toBe(false)
  })
})
