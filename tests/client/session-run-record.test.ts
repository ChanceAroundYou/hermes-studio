// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * The behaviour of the single run record.
 *
 * The structural invariants are in session-run-single-writer.test.ts, which
 * reads the source and needs no DOM. This half drives the record and checks that
 * every reader agrees, because the failures that kept coming back were exactly
 * the cases where two of them did not.
 */

vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn((sid, cb) => cb({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })),
  registerSessionHandlers: vi.fn(),
  connectChatRun: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ connected: true, emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(), onSessionCommand: vi.fn(),
  onSessionTitleUpdated: vi.fn(), onSessionWorkspaceUpdated: vi.fn(),
  onSessionSettingsUpdated: vi.fn(), onRunUsageUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false, getBaseUrlValue: () => '' }))
// `vi.mock` factories are hoisted above the const, so the id is spelled out.
const SESSION_ROW = { id: 'session-record', title: 'session-record', profile: 'default', createdAt: 0, updatedAt: 0, messageCount: 0 }
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(),
  fetchSessions: vi.fn(async (source?: string) => (source === 'global_agent' ? [] : [SESSION_ROW])),
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

const sessionsApi = vi.hoisted(() => ({ fetchWorkingSessions: vi.fn(async () => [] as any[]) }))

import { useChatStore } from '@/stores/hermes/chat'

const SID = 'session-record'

let store: ReturnType<typeof useChatStore>

beforeEach(() => {
  sessionsApi.fetchWorkingSessions.mockResolvedValue([])
  setActivePinia(createPinia())
  store = useChatStore()
})

describe('the whole record moves together', () => {
  it('adopts and releases as one, with every reader agreeing', () => {
    // Three readers used to consult three different maps. They answer from one
    // record now, so they cannot disagree.
    expect(store.isSessionWorking(SID)).toBe(false)

    store.markSessionRunning(SID, Date.now())
    expect(store.isSessionLive(SID)).toBe(true)
    expect(store.serverWorking.has(SID)).toBe(true)
    expect(store.runStartedAt.get(SID)).toBeGreaterThan(0)

    store.markSessionIdle(SID)
    expect(store.isSessionWorking(SID)).toBe(false)
    expect(store.sessionRuns.get(SID)).toBeUndefined()
    expect(store.serverWorking.has(SID)).toBe(false)
    expect(store.runStartedAt.get(SID)).toBeUndefined()
  })

  it('stays lit however far the clock moves past the run start', async () => {
    // The reported failure, reproduced. A session on the running server was
    // reported as `run_state: "running"` with a live run id, and its ring was
    // dark -- because the client aged the run against `run_started_at`, which is
    // when the run *began*. Fourteen minutes in, it read exactly like a leaked
    // flag. The clock is advanced by a month on purpose: a test that moved it by
    // an hour would still pass with a one-day window in place, and the point is
    // that no window may exist at all -- see the structural guard in
    // sidebar-live-settle.test.ts for the same invariant stated directly.
    const started = Date.now()
    await store.refreshSessionListOnly()
    sessionsApi.fetchWorkingSessions.mockResolvedValue([{
      session_id: SID, run_started_at: started - 30_000,
      source: 'coding_agent', compression: null, background_pending: 0,
      run_state: 'running', run_id: 'run-live',
    }])
    await store.refreshSessionListOnly()
    expect(store.isSessionLive(SID)).toBe(true)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(started + 30 * 24 * 60 * 60_000)
      await store.refreshSessionListOnly()
      expect(store.isSessionLive(SID)).toBe(true)
      expect(store.isSessionWorking(SID)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still goes dark on the poll after the server stops reporting it', async () => {
    // The other half: no window is not the same as no end. What ends the run is
    // the snapshot, on the same poll that started it.
    const started = Date.now()
    await store.refreshSessionListOnly()
    sessionsApi.fetchWorkingSessions.mockResolvedValue([{
      session_id: SID, run_started_at: started - 30_000,
      source: 'coding_agent', compression: null, background_pending: 0,
      run_state: 'running', run_id: 'run-live',
    }])
    await store.refreshSessionListOnly()
    expect(store.isSessionLive(SID)).toBe(true)

    vi.useFakeTimers()
    try {
      // An hour later the server finishes the run and stops listing it.
      vi.setSystemTime(started + 30 * 24 * 60 * 60_000)
      sessionsApi.fetchWorkingSessions.mockResolvedValue([])
      await store.refreshSessionListOnly()
      expect(store.isSessionLive(SID)).toBe(false)
      expect(store.sessionRuns.get(SID)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a run live however long it has been going', async () => {
    // The reported regression. `run_started_at` is when the run *began*, not when
    // it was last heard from, so an age bound on it unlit every run that outlived
    // the window: a fourteen-minute session sat dark while a three-minute one lit
    // normally beside it.
    await store.refreshSessionListOnly()
    sessionsApi.fetchWorkingSessions.mockResolvedValue([{
      session_id: SID, run_started_at: Date.now() - 14 * 60_000,
      source: 'cli', compression: null, background_pending: 0,
      run_state: 'running', run_id: 'run-long',
    }])
    await store.refreshSessionListOnly()

    expect(store.isSessionLive(SID)).toBe(true)
    expect(store.isSessionWorking(SID)).toBe(true)
    // The clock still reports when the run began, which is what the elapsed timer
    // reads -- it just no longer decides whether the run exists.
    expect(store.runStartedAt.get(SID)).toBeLessThan(Date.now() - 13 * 60_000)
  })

  it('keeps the run identity when a later patch mentions only the phase', async () => {
    // The snapshot names the run. A socket event that says nothing but "this is
    // running" must not erase that name: the abort carries it, and an abort that
    // names a run the server is no longer on is dropped as stale -- which turns
    // a stop into a silent no-op rather than a visible failure.
    //
    // This is what a partial patch silently does when it writes every field
    // instead of only the ones it was given.
    await store.refreshSessionListOnly()
    sessionsApi.fetchWorkingSessions.mockResolvedValue([{
      session_id: 'session-record', run_started_at: Date.now() - 30_000,
      source: 'coding_agent', compression: null, background_pending: 0,
      run_state: 'running', run_id: 'run-abc',
    }])
    await store.refreshSessionListOnly()
    expect(store.sessionRuns.get('session-record')?.runId).toBe('run-abc')

    // A socket event, which knows about the phase and nothing else.
    store.markSessionRunning('session-record')

    expect(store.sessionRuns.get('session-record')?.runId).toBe('run-abc')
    expect(store.sessionRuns.get('session-record')?.startedAt).toBeGreaterThan(0)
  })

  it('lets a delegation outlive the run that started it', async () => {
    // A delegation runs outside the foreground run, which is why it is a field
    // and not part of the phase: clearing the run must not clear it.
    await store.refreshSessionListOnly()
    expect(store.sessions.some(s => s.id === SID)).toBe(true)

    store.markSessionRunning(SID, Date.now())
    store.setBackgroundPending(SID, 2)
    store.markSessionIdle(SID)

    expect(store.isSessionLive(SID)).toBe(false)
    expect(store.isSessionWorking(SID)).toBe(true)
  })

  it('drops the entry when nothing is left to say', () => {
    // `has` has to mean "this session has something to report", not "this
    // session was mentioned once" -- a cleared session that stayed in the map
    // was consulted by every reader in the file.
    store.markSessionRunning(SID, Date.now())
    expect(store.sessionRuns.has(SID)).toBe(true)
    store.markSessionIdle(SID)
    expect(store.sessionRuns.has(SID)).toBe(false)
  })

  it('reports the phase the record actually holds', () => {
    // The reported sticky ring, as a behaviour: reconciling has to release every
    // field, including the phase.
    store.markSessionRunning(SID, Date.now())
    expect(store.isSessionWorking(SID)).toBe(true)

    store.reconcileSessionIdle(SID)

    expect(store.isSessionWorking(SID)).toBe(false)
    expect(store.isSessionLive(SID)).toBe(false)
    expect(store.sessionRuns.get(SID)).toBeUndefined()
  })

  it('keeps an attached stream as the reason a session reads as live', () => {
    // The bridge path attaches a stream for a run it already knows about and
    // never sets the phase itself, so the stream alone has to count.
    store.attachSessionStream(SID, { abort: vi.fn() })
    expect(store.isSessionLive(SID)).toBe(true)
    expect(store.streamStates.has(SID)).toBe(true)
  })

  it('holds an attached stream live until something clears it', () => {
    // No clock here either, for the same reason: a long stream would expire with
    // the run still going. What clears a leftover stream is the session's own
    // cleanup, reconciliation, or the snapshot dropping the session -- and the
    // poll now runs while a stream is attached, so that last one always happens.
    store.attachSessionStream(SID, { abort: vi.fn() })
    store.markSessionRunning(SID, Date.now() - 600_000)
    expect(store.isSessionLive(SID)).toBe(true)

    store.markSessionIdle(SID)
    expect(store.isSessionLive(SID)).toBe(false)
  })
})
