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

/** `source: 'global_agent'` is the second half of the runtime-session merge. */
function listSessions(...ids: string[]) {
  sessionsApi.fetchSessions.mockImplementation(async (source?: string) => (
    source === 'global_agent'
      ? []
      : ids.map(id => ({ id, title: id, profile: 'default', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }))
  ))
}

/** The `working-sessions` payload, with each run's start pinned by the caller. */
function workingSnapshot(entries: Array<[sessionId: string, runStartedAt: number]>) {
  sessionsApi.fetchWorkingSessions.mockResolvedValue(entries.map(([session_id, run_started_at]) => ({
    session_id, run_started_at, source: 'coding_agent', compression: null,
  })))
}

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  api.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  api.resumeSession.mockImplementation((sid, callback) => {
    callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })
  })
  listSessions()
  workingSnapshot([])
})

describe('sidebar working flags from the working-sessions snapshot', () => {
  it('lights up a session the server reports as working even while the current one streams', async () => {
    // This is the whole point of the poll: the sidebar must show other
    // sessions working without opening them. It used to be skipped entirely
    // whenever the *current* session was streaming, which on mobile is the only
    // state you are ever in while waiting for a background run.
    listSessions('me', 'painting')
    const store = useChatStore()
    // Make `me` the current session and put it in the state a live run leaves.
    store.activeSessionId = 'me'
    store.serverWorking.add('me')
    store.streamStates.set('me', { abort: vi.fn() })
    expect(store.isStreaming).toBe(true)

    workingSnapshot([['me', Date.now()], ['painting', Date.now()]])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('painting')).toBe(true)
  })

  it('keeps a run lit when the snapshot raced its start and does not list it', async () => {
    // The snapshot is a plain HTTP read: it can be taken before the run it
    // would report. Clearing the flag there would make the sidebar blink out
    // for a whole poll interval.
    listSessions('me', 'painting')
    const store = useChatStore()
    workingSnapshot([['me', Date.now() - 14_000]])
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking('me')).toBe(true)

    workingSnapshot([['painting', Date.now()]])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('me')).toBe(true)
  })

  it('still clears a leaked flag for a run that started long ago', async () => {
    // The counterpart: without this the poll would only ever add lights, and a
    // session whose terminal event was lost would show as working forever.
    listSessions('stale', 'painting')
    const store = useChatStore()
    workingSnapshot([['stale', Date.now() - 60_000]])
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking('stale')).toBe(true)

    workingSnapshot([['painting', Date.now()]])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('stale')).toBe(false)
  })
})
