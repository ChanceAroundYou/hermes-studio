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
  onRunUsageUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false, getBaseUrlValue: () => '' }))

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

describe('the sidebar mirrors the server\'s activity time', () => {
  it('takes the server value as-is, even when it is older than what we had', async () => {
    serverSees(1_789_995_333)
    const store = await settle()
    expect(store.sessions[0].updatedAt).toBe(1_789_995_333 * 1000)

    // Anything the client had locally is not authoritative and must not survive.
    store.sessions[0].updatedAt = Date.now()

    serverSees(1_789_995_333)
    await settle()
    expect(store.sessions[0].updatedAt).toBe(1_789_995_333 * 1000)
  })

  it('follows the server forward when a run is in flight', async () => {
    serverSees(1_789_995_333)
    const store = await settle()

    // The server advanced because messages were persisted.
    const running = 1_789_999_999
    serverSees(running)
    await settle()
    expect(store.sessions[0].updatedAt).toBe(running * 1000)
  })

  it('never invents activity locally', async () => {
    serverSees(1_789_995_333)
    const store = await settle()
    // Polling repeatedly must not drift the timestamp at all.
    for (let i = 0; i < 4; i += 1) await settle()
    expect(store.sessions[0].updatedAt).toBe(1_789_995_333 * 1000)
  })
})
