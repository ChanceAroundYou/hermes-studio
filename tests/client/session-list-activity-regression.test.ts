// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(), connectChatRun: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  ...api,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(), onSessionCommand: vi.fn(),
  onSessionTitleUpdated: vi.fn(), onSessionWorkspaceUpdated: vi.fn(),
  onSessionSettingsUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))

const sessionsApi = vi.hoisted(() => ({ fetchSessions: vi.fn(), fetchWorkingSessions: vi.fn() }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(),
  fetchSessions: sessionsApi.fetchSessions,
  fetchWorkingSessions: sessionsApi.fetchWorkingSessions,
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

const SESSION = 'mssl3we9'

/** The server's view of one session; `lastActive` is the only field that matters here. */
function serverSees(lastActiveSeconds: number) {
  sessionsApi.fetchSessions.mockImplementation(async (source?: string) => (
    source === 'global_agent'
      ? []
      : [{
          id: SESSION,
          title: '网络优化',
          profile: 'default',
          source: 'cli',
          started_at: 1_700_000_000,
          ended_at: null,
          last_active: lastActiveSeconds,
          message_count: 30779,
        }]
  ))
}

async function settle() {
  const store = useChatStore()
  await store.refreshSessionListOnly()
  // Let the follow-up working-sessions snapshot resolve too.
  await new Promise(resolve => setTimeout(resolve, 0))
  return store
}

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  api.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  api.resumeSession.mockImplementation((sid, callback) => {
    callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })
  })
  sessionsApi.fetchWorkingSessions.mockResolvedValue([])
})

describe('session activity time is monotonic across polls', () => {
  it('does not roll a locally observed time back to the server older last_active', async () => {
    // Server still thinks the session was last touched at 16:09.
    serverSees(1_789_995_333)
    const store = await settle()
    const serverOnlyTime = store.sessions[0].updatedAt

    // The user opens it and activity is observed locally (socket deltas,
    // generated title, ...), which bumps it to "now".
    const localTime = Date.now()
    store.sessions[0].updatedAt = localTime

    // The next 12s poll still reports the stale 16:09.
    await settle()

    expect(store.sessions[0].updatedAt).toBe(localTime)
    expect(store.sessions[0].updatedAt).toBeGreaterThan(serverOnlyTime)
  })

  it('still adopts a newer server time, so another device re-orders the list', async () => {
    serverSees(1_789_995_333)
    const store = await settle()
    const before = store.sessions[0].updatedAt

    // Another device used the session: the server is now ahead.
    const newer = before + 5 * 60_000
    serverSees(Math.floor(newer / 1000) + 1)
    await settle()

    expect(store.sessions[0].updatedAt).toBeGreaterThanOrEqual(newer)
  })

  it('keeps the row stable across repeated polls carrying the same data', async () => {
    serverSees(1_789_995_333)
    const store = await settle()
    const first = store.sessions[0].updatedAt
    await settle()
    await settle()
    expect(store.sessions[0].updatedAt).toBe(first)
  })
})
