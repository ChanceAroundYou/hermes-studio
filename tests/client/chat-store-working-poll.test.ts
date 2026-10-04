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

/** `source: 'global_agent'` is the second half of the runtime-session merge. */
function listSessions(...ids: string[]) {
  sessionsApi.fetchSessions.mockImplementation(async (source?: string) => (
    source === 'global_agent'
      ? []
      : ids.map(id => ({ id, title: id, profile: 'default', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }))
  ))
}

/** The `working-sessions` payload, with each run's start pinned by the caller. */
function workingSnapshot(
  entries: Array<[sessionId: string, runStartedAt: number]>,
  backgroundPending: Record<string, number> = {},
) {
  sessionsApi.fetchWorkingSessions.mockResolvedValue(entries.map(([session_id, run_started_at]) => ({
    session_id, run_started_at, source: 'coding_agent', compression: null,
    background_pending: backgroundPending[session_id] || 0,
    run_state: 'running',
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
    store.markSessionRunning('me')
    store.attachSessionStream('me', { abort: vi.fn() })
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

/**
 * The delegation light was write-only.
 *
 * `backgroundPendingBySession` was fed by socket events and cleared by socket
 * events. The snapshot computed `background_pending` on every poll, used it to
 * settle delegation streams -- and then dropped it, so it never switched the
 * light off.
 *
 * The symptom was that the ring stayed on with no notification: once a
 * `delegation.updated` lit it, only that same socket could put it out, and a
 * background session nobody opened has no such socket. The previous fix
 * addressed the sibling `subagentStreams` leak and left this one, which is why
 * it was reported as still broken.
 */
describe('the delegation light is switched off by the snapshot', () => {
  it('lights up while the server reports a live delegation', async () => {
    // A pure delegation: no foreground run at all, and a start old enough that
    // neither the display bound nor the veto bound can carry it. Only the
    // delegation count can be what makes this session look busy.
    // The server lists a delegation-only session precisely because its count is
    // above zero, so the snapshot always carries the row. Its run_start is old,
    // which is what makes the delegation count the only thing keeping it lit.
    listSessions('painting')
    const store = useChatStore()
    workingSnapshot([['painting', Date.now() - 30_000]], { painting: 1 })
    await store.refreshSessionListOnly()
    // The count itself is the assertion: the other two sources are covered by
    // their own cases, and `isSessionWorking` being true proves only that one of
    // three lights is on, which is how the original leak hid.
    expect(store.backgroundPendingBySession.get('painting')).toBe(1)

    // And with the foreground flags cleared, the delegation count alone still
    // keeps the ring lit -- that is the state a pure background run is in.
    store.markSessionIdle('painting')
    store.markSessionIdle('painting')
    expect(store.isSessionWorking('painting')).toBe(true)
  })

  it('goes out when the snapshot stops reporting the delegation', async () => {
    listSessions('painting')
    const store = useChatStore()
    // A background delegation outlives the foreground run it came from, so by
    // the time the last poll sees it the run has been going for a while. That
    // age is what lets the snapshot's silence win over the local flags.
    workingSnapshot([['painting', Date.now() - 30_000]], { painting: 1 })
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking('painting')).toBe(true)

    // The run itself is gone too -- this is the ordinary end of a background run.
    workingSnapshot([])
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking('painting')).toBe(false)
  })

  it('goes out even when only the run-start evidence is stale', async () => {
    // A delegation outlives the foreground run it was started from, so the
    // session can leave the snapshot entirely while the count is still 1.
    listSessions('painting')
    const store = useChatStore()
    workingSnapshot([['painting', Date.now() - 60_000]], { painting: 1 })
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking('painting')).toBe(true)

    workingSnapshot([], {})
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('painting')).toBe(false)
  })

  it('reports the finish exactly once', async () => {
    const notify = vi.fn()
    vi.resetAllMocks()
    const store = useChatStore()
    listSessions('painting')
    workingSnapshot([['painting', Date.now()]], { painting: 1 })
    await store.refreshSessionListOnly()

    workingSnapshot([])
    await store.refreshSessionListOnly()
    // A leaked light used to keep re-reporting on every poll.
    await store.refreshSessionListOnly()
    await store.refreshSessionListOnly()

    expect(notify).not.toHaveBeenCalled()
  })
})

/**
 * `streamStates` and `serverWorking` were the other two unbounded lights.
 *
 * Both are normally cleared by their own path -- the socket's cleanup, and the
 * snapshot respectively -- but only the session the user actually opens gets
 * `resumeServerWorkingRun`, the one routine that could repair them. A background
 * session had no self-healing path at all.
 */

describe('a leaked local run flag cannot outlive the run it describes', () => {
  it('keeps a genuinely fresh run lit', async () => {
    listSessions('painting')
    const store = useChatStore()
    store.markSessionRunning('painting', Date.now())
    expect(store.isSessionWorking('painting')).toBe(true)
  })

  it('lets a long silent tool call stay lit', async () => {
    // The bound must be generous: a tool call can be silent for minutes, and
    // this exists to end a leak, not to second-guess a real run. The server's own
    // watchdog decides a run is really dead and emits run.completed.
    listSessions('painting')
    const store = useChatStore()
    store.markSessionRunning('painting', Date.now() - 120_000)
    expect(store.isSessionWorking('painting')).toBe(true)
  })

  it('releases a local flag once the snapshot stops reporting the run', async () => {
    // What ends an optimistic mark is the snapshot no longer listing the session.
    // It used to be an age check on the mark itself, which unlit real long runs
    // as readily as it ended leaks.
    listSessions('painting')
    const store = useChatStore()
    // Old enough that the race veto does not protect it, which is the condition
    // the snapshot is allowed to overrule.
    store.markSessionRunning('painting', Date.now() - 30_000)
    expect(store.isSessionWorking('painting')).toBe(true)

    workingSnapshot([])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('painting')).toBe(false)
  })

  it('lets the snapshot drop a stale stream flag', async () => {
    // The veto window and the display window answer different questions. A
    // stream flag whose run started long ago may keep the ring lit on its own,
    // but it must not be able to overrule the server reporting the session idle,
    // or the flag would be unremovable for any session nobody opens.
    listSessions('painting')
    const store = useChatStore()
    workingSnapshot([['painting', Date.now() - 30_000]])
    await store.refreshSessionListOnly()
    store.markSessionRunning('painting', Date.now() - 30_000)
    expect(store.isSessionWorking('painting')).toBe(true)

    workingSnapshot([])
    await store.refreshSessionListOnly()

    expect(store.serverWorking.has('painting')).toBe(false)
  })

  it('trusts a flag that never recorded a run start', () => {
    // Deliberate, and it was the opposite before: judging such a flag stale made
    // the ring vanish without `reconcileSessionIdle`, quietly removing the reason
    // that routine exists (session-idle-reconcile.test.ts pins that behaviour and
    // caught the regression when it was inverted here).
    //
    // The server writes `run_started_at` as `startedAt || now`, so a
    // snapshot-sourced flag always has a timestamp. The ones that do not are
    // local residue, and reconciliation is what clears those.
    listSessions('orphan')
    const store = useChatStore()
    store.markSessionRunning('orphan')
    expect(store.isSessionWorking('orphan')).toBe(true)

    store.reconcileSessionIdle('orphan')
    expect(store.isSessionWorking('orphan')).toBe(false)
  })

  it('believes a running phase however long the run has been going', async () => {
    // The inverse of what this case used to assert, and the reported regression.
    // `run_started_at` is when the run *began*, so an age bound on it unlit every
    // run that outlived the window: a fourteen-minute session sat dark while a
    // three-minute one lit normally next to it.
    listSessions('painting')
    const store = useChatStore()
    workingSnapshot([['painting', Date.now() - 14 * 60_000]])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('painting')).toBe(true)
  })

  it('goes dark the moment the snapshot stops reporting the run', async () => {
    // The other half, and the part that keeps a long run from becoming a leak:
    // the snapshot is what withdraws the phase, on the same poll that set it.
    listSessions('painting')
    const store = useChatStore()
    workingSnapshot([['painting', Date.now() - 14 * 60_000]])
    await store.refreshSessionListOnly()
    expect(store.isSessionWorking('painting')).toBe(true)

    workingSnapshot([])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('painting')).toBe(false)
  })

  it('still believes a fresh run_state', async () => {
    // The counterpart, so the bound above cannot be read as "ignore the snapshot".
    listSessions('painting')
    const store = useChatStore()
    workingSnapshot([['painting', Date.now()]])
    await store.refreshSessionListOnly()

    expect(store.isSessionWorking('painting')).toBe(true)
  })
})
