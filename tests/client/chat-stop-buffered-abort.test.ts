// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * A stop has to survive a reconnect, and the ring has to agree with the server.
 *
 * Observed from a phone: the socket dropped, the user pressed stop, and the
 * server logged nothing at all -- the request never left the tab. The client
 * refused to send it:
 *
 *     if (!socket || !socket.connected) return false
 *
 * socket.io buffers an emit while the socket is down and delivers it on
 * reconnect, so that guard threw away a mechanism that already worked and
 * reported a recoverable stop as a failure.
 *
 * Buffering is only safe because the request now names the run it means. A
 * buffered emit can arrive after that run ended and another started; without an
 * id the server could only read it as "stop something" and would kill the wrong
 * run. Both halves are pinned here.
 */

const emitted: Array<{ event: string; payload: any }> = []
let socketConnected = true
let socketAvailable = true

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(), connectChatRun: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  ...api,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => (socketAvailable
    ? {
      get connected() { return socketConnected },
      emit: (event: string, payload: any) => { emitted.push({ event, payload }) },
    }
    : null)),
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

const SID = 'session-stop'

/**
 * How old the reported run start is.
 *
 * Two windows answer different questions, and the tests have to sit on the
 * right side of both. A start younger than the snapshot-veto window cannot be
 * cleared by an empty snapshot at all -- that is the deliberate protection
 * against a snapshot that raced the run it would report. Thirty seconds is old
 * enough to be clearable and young enough to still count as live.
 */
const RUNNING_LONG_ENOUGH_TO_BE_CLEARABLE = 30_000

function listSessions() {
  sessionsApi.fetchSessions.mockImplementation(async (source?: string) => (
    source === 'global_agent'
      ? []
      : [{ id: SID, title: SID, profile: 'default', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }]
  ))
}

function workingSnapshot(
  runId: string,
  runState: 'running' | 'finishing' | 'idle' = 'running',
  startedAgoMs = RUNNING_LONG_ENOUGH_TO_BE_CLEARABLE,
) {
  sessionsApi.fetchWorkingSessions.mockResolvedValue([{
    session_id: SID, run_started_at: Date.now() - startedAgoMs, source: 'coding_agent',
    compression: null, background_pending: 0, run_state: runState, run_id: runId,
  }])
}

function emptySnapshot() {
  sessionsApi.fetchWorkingSessions.mockResolvedValue([])
}

beforeEach(() => {
  vi.resetAllMocks()
  emitted.length = 0
  socketConnected = true
  socketAvailable = true
  setActivePinia(createPinia())
  api.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  api.resumeSession.mockImplementation((sid, callback) => {
    callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })
  })
  listSessions()
  emptySnapshot()
})

describe('a stop is delivered even when the socket is down', () => {
  it('buffers the abort instead of refusing to send it', async () => {
    // The reported failure in miniature: a dropped socket must not be reported
    // as "stop was not confirmed" when socket.io would deliver it on reconnect.
    const store = useChatStore()
    store.activeSessionId = SID
    workingSnapshot('run-abc')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(true)

    socketConnected = false
    store.stopStreaming()

    const aborts = emitted.filter(e => e.event === 'abort')
    expect(aborts).toHaveLength(1)
    expect(aborts[0].payload.session_id).toBe(SID)
  })

  it('does not report the failure it used to report', async () => {
    const store = useChatStore()
    store.activeSessionId = SID
    workingSnapshot('run-abc')
    await store.refreshSessionListOnly()

    socketConnected = false
    store.stopStreaming()

    expect(store.abortState?.error).toBeFalsy()
    expect(store.abortState?.aborting).toBe(true)
  })

  it('still fails when there is no socket to buffer into', () => {
    // The guard was not wrong in every case: with no socket object there is
    // nothing to hold the request, so it remains a failure.
    const store = useChatStore()
    store.activeSessionId = SID
    store.serverWorking.add(SID)
    store.runStartedAt.set(SID, Date.now())
    expect(store.isSessionWorking(SID)).toBe(true)

    socketAvailable = false
    store.stopStreaming()

    expect(store.abortState?.error).toBeTruthy()
    expect(store.abortState?.aborting).toBe(false)
  })
})

describe('an abort names the run it means', () => {
  it('carries the run id the server reported', async () => {
    // Without this the request is only "stop something", and a buffered one
    // delivered late would kill whatever run had replaced the intended one.
    const store = useChatStore()
    store.activeSessionId = SID
    workingSnapshot('run-abc')
    await store.refreshSessionListOnly()

    store.stopStreaming()

    expect(emitted.find(e => e.event === 'abort')?.payload.run_id).toBe('run-abc')
  })

  it('omits the id rather than inventing one', async () => {
    // A fabricated id would be dropped by the server as stale, silently turning
    // every stop into a no-op. No id means "stop whatever is running".
    const store = useChatStore()
    store.activeSessionId = SID
    store.serverWorking.add(SID)
    store.runStartedAt.set(SID, Date.now())

    store.stopStreaming()

    const abort = emitted.find(e => e.event === 'abort')
    expect(abort).toBeTruthy()
    expect(abort?.payload.run_id).toBeUndefined()
  })

  it('follows the id when the server swaps the run', async () => {
    const store = useChatStore()
    store.activeSessionId = SID
    workingSnapshot('run-one')
    await store.refreshSessionListOnly()
    store.stopStreaming()
    expect(emitted.find(e => e.event === 'abort')?.payload.run_id).toBe('run-one')

    // The first stop is confirmed, which is what clears `aborting`; without that
    // the second press would be ignored as a duplicate rather than tested.
    store.abortState = null
    emitted.length = 0
    workingSnapshot('run-two')
    await store.refreshSessionListOnly()
    store.stopStreaming()
    expect(emitted.find(e => e.event === 'abort')?.payload.run_id).toBe('run-two')
  })
})

describe('the snapshot drives the ring for a coding-agent session', () => {
  it('lights a session the server reports as running', async () => {
    // The other half of the same report: an Ekko run is never `isWorking`, so
    // before the snapshot covered run-manager runs the ring could only light
    // from a socket event -- and a client that missed it had no way to learn the
    // run was live, let alone that it had ended.
    const store = useChatStore()
    workingSnapshot('run-abc')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(true)
  })

  it('goes out when the server stops reporting the run', async () => {
    const store = useChatStore()
    workingSnapshot('run-abc')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(true)

    emptySnapshot()
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(false)
  })

  it('stays dark for a live but idle agent', async () => {
    // `hasSession` stays true between turns. Reporting that as busy would keep
    // the ring lit while the agent sits waiting for the next message.
    const store = useChatStore()
    workingSnapshot('run-abc', 'idle')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(false)
  })

  it('stays dark while a run is only finishing', async () => {
    // `finishing` is reported so the client can tell it apart from idle, and is
    // deliberately not busy. Adding it to `serverWorking` -- which the snapshot
    // loop used to do for every entry it contained -- lit the ring anyway.
    const store = useChatStore()
    workingSnapshot('run-abc', 'finishing')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(false)
  })

  it('puts the ring out when a running entry becomes a finishing one', async () => {
    // The transition, not just the steady state: the flag has to be withdrawn,
    // not merely never set.
    const store = useChatStore()
    workingSnapshot('run-abc')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(true)

    workingSnapshot('run-abc', 'finishing')
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking(SID)).toBe(false)
  })
})
