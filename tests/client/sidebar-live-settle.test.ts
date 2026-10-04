import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The sidebar ring spun forever.
 *
 * `isSessionLive` -> `serverWorking` is healed every poll by
 * `applyWorkingSessionsSnapshot`, which was written to heal exactly this class
 * of leak: a run-scoped compression banner whose completion event was lost.
 * Delegations were never reconciled, and they could not be, because a
 * background delegation runs outside `isWorking` and so never appeared in the
 * working-sessions snapshot at all.
 *
 * That made two rules deadlock:
 *
 *   - `hasLocalRunEvidence` said "this session is still running" forever,
 *     because a `running` subagent stream vetoed the snapshot without any bound;
 *   - `dropped` therefore never dropped `serverWorking`.
 *
 * The only thing that broke the deadlock was opening the conversation, because
 * resume calls `settleInterruptedSubagents`. Hence "it spins until I click it".
 * The server also never reported completion for those runs: `run.completed` is
 * delivered on the socket for the attached session only.
 *
 * These assertions pin the three parts of the fix: the server now reports
 * background delegations, the client settles them from that authority, and the
 * end is reported instead of being inferred by the user.
 */

const chat = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')
const sessionsApi = readFileSync('packages/client/src/api/studio/sessions.ts', 'utf8')
const socket = readFileSync('packages/server/src/modules/studio/sockets/chat-run.ts', 'utf8')
const controller = readFileSync('packages/server/src/modules/studio/controllers/chat-run.ts', 'utf8')

describe('the server reports background delegations', () => {
  it('lists a session whose only live work is a delegation', () => {
    // Without this the client cannot distinguish "delegation finished" from
    // "snapshot never mentioned it", which was the whole deadlock.
    expect(socket).toMatch(
      /const backgroundPending = this\.backgroundPendingCount\(state\)[\s\S]{0,200}backgroundPending === 0\) continue/,
    )
  })

  it('sends the count to the client', () => {
    expect(controller).toMatch(/background_pending:\s*Number\(session\.backgroundPending\)\s*\|\|\s*0/)
    expect(sessionsApi).toMatch(/background_pending\?:\s*number/)
  })
})

describe('a leaked delegation cannot veto the snapshot forever', () => {
  it('bounds the subagent veto the way every other evidence source is bounded', () => {
    // The run-start evidence next to it already has a freshness window. An
    // unbounded delegation stream was the one that never aged out.
    expect(chat).toMatch(/const SUBAGENT_EVIDENCE_FRESHNESS_MS = \d+_?\d*/)
    expect(chat).toMatch(/now - subagent\.updatedAt < SUBAGENT_EVIDENCE_FRESHNESS_MS/)
  })

  it('does not just delete the check', () => {
    // A still-updating delegation is real evidence and must keep the ring lit.
    expect(chat).not.toMatch(/for \(const subagent of subagentStreams\.value\.values\(\)\) \{\s*continue/)
  })
})

describe('the client settles delegations from the authoritative snapshot', () => {
  it('settles before the snapshot consults the same streams', () => {
    const settleAt = chat.indexOf('settleInterruptedSubagents(stream.sessionId)')
    const evidenceAt = chat.indexOf('const dropped')
    expect(settleAt).toBeGreaterThan(-1)
    // Ordering is the fix. Reconciling after the filter would deadlock against
    // itself, which is the bug being fixed here.
    expect(settleAt).toBeLessThan(evidenceAt)
  })

  it('keeps a session that still has a foreground run or a pending delegation', () => {
    // Anchored on the loop itself: `nextRunStates` also appears earlier in the
    // file, so slicing between two occurrences of it silently produced the
    // wrong window.
    const loopAt = chat.indexOf('for (const stream of [...subagentStreams.value.values()])')
    expect(loopAt).toBeGreaterThan(-1)
    const block = chat.slice(loopAt, loopAt + 700)
    expect(block).toMatch(/if \(live\.has\(stream\.sessionId\)\) continue/)
    // Killing a live delegation is the regression this has to avoid: background
    // work is exactly what the count exists to protect.
    expect(block).toMatch(/backgroundPending\.get\(stream\.sessionId\) \|\| 0\) > 0\) continue/)
  })
})

describe('a finished run is reported', () => {
  it('routes every completion path through one exit, once per session', () => {
    expect(chat).toMatch(/function settleSessionFinished\(sessionId: string, messageId\?: string \| null\)/)
    expect(chat).toMatch(/if \(alreadyReported\) return/)
    expect(chat).toMatch(/showCompletionNotificationIfEnabled\(sid, messageId \?\? null\)/)
  })

  it('actually calls it from the poll loop', () => {
    // Asserting only the function body let a mutation that removed the call site
    // pass: the helper still existed, it was just never invoked. The symptom is
    // precisely "the end is never reported".
    const pollAt = chat.indexOf('const dropped')
    const loop = chat.slice(pollAt, pollAt + 900)
    expect(loop).toMatch(/settleSessionFinished\(id\)/)
  })

  it('has exactly one exit, so a new path cannot bypass the dedupe', () => {
    // Three paths used to conclude "done" on their own -- two run.completed
    // handlers and the poll -- and only the poll consulted the dedupe set, so
    // one completion could notify twice. `showCompletionNotificationIfEnabled`
    // is the single remaining caller, and it is reached only through the exit.
    const exits = chat.match(/settleSessionFinished\(/g) || []
    // 1 definition + 1 poll call + 2 run.completed calls
    expect(exits.length).toBe(4)
    const notifyCalls = chat.match(/showCompletionNotificationIfEnabled\(/g) || []
    // 1 inside the exit, 1 inside its own definition, 0 elsewhere in the store
    expect(notifyCalls.length).toBe(2)
  })

  it('polls the cheap endpoint on its own short interval', () => {
    // The completion notice for a session this client is not attached to can
    // only be learned from the snapshot, so notice latency was the old 12s tick.
    // The fast tick must NOT reuse refreshSessionListOnly, which is a DB read.
    expect(chat).toMatch(/const WORKING_SNAPSHOT_POLL_MS = 3_000/)
    const fastPoll = chat.slice(chat.indexOf('let workingSnapshotPollInFlight'))
    expect(fastPoll.slice(0, 900)).toMatch(/void applyWorkingSessionsSnapshot\(\)/)
    expect(fastPoll.slice(0, 900)).not.toMatch(/refreshSessionListOnly/)
  })

  it('covers both ways a run ends without the client attached', () => {
    expect(chat).toMatch(/new Set\(\[\.\.\.dropped, \.\.\.finishedBySnapshot\]\)/)
  })

  it('lets the next run report itself again', () => {
    // The marker is cleared for every entry the snapshot still lists. Written
    // against the entry id however it is spelled -- the loop now hoists it into
    // `sid`, because the same value guards the run id and the phase as well.
    expect(chat).toMatch(/snapshotFinishNotified\.delete\(sid\)/)
    expect(chat).toMatch(/const sid = String\(entry\.session_id\)/)
  })

  it('stays silent for the session the user is already looking at', () => {
    // Otherwise opening a stale conversation fires a notification for the very
    // run the user is reading, which they did not ask to be told about.
    expect(chat).toMatch(/if \(sid === activeSessionId\.value\) return/)
  })
})

describe('the end signal is not inferred from a timer', () => {
  it('keeps settleInterruptedSubagents the single settling primitive', () => {
    // A second, poll-local mutation of subagent streams would drift from the one
    // resume and abort already use.
    const direct = chat.match(/subagentStreams\.value\.(set|delete)\(/g) || []
    expect(direct.length).toBeGreaterThan(0)
    expect(chat).toMatch(/settleInterruptedSubagents\(stream\.sessionId\)/)
  })

  it('keeps the existing compression reconciliation intact', () => {
    // The same healing idea, and the reason this one was expected to exist.
    expect(chat).toMatch(/reconcileCompressionState\(String\(entry\.session_id\)/)
  })
})
/**
 * `runState` was written when a run started and never written back.
 *
 * `state.isWorking` is assigned `!isCodingAgentExecution(...)`, so for a
 * coding-agent session it is false from the start. That session is then excluded
 * from the snapshot by the filter -- until a background delegation puts it back
 * in, still carrying the `running` stamp from a run that is long over.
 *
 * The client believed it, on every poll, forever. That is the root cause of the
 * ring that would not go out and the completion notice that never arrived, and
 * it survived an earlier fix because that one only bounded the *client's* flags.
 */
describe('the snapshot derives the phase instead of reporting a stale one', () => {
  it('does not report a stale running for a session that is not working', () => {
    const listing = socket.slice(socket.indexOf('const runState = state.runState'))
    const block = listing.slice(0, listing.indexOf('\n      }'))
    // Asserted at the assignment, not on the name: reverting this to
    // `runState ?? 'running'` keeps every other line in the file identical.
    expect(block).toMatch(/runState: effectiveRunState/)
    expect(block).toMatch(/const effectiveRunState[^=]*=\s*state\.isWorking/)
    expect(block).toMatch(/runState === 'finishing' \? 'finishing' : 'idle'/)
  })

  it('still reports the finalizing phase, which is deliberately not idle', () => {
    const listing = socket.slice(socket.indexOf('const runState = state.runState'))
    const block = listing.slice(0, listing.indexOf('\n      }'))
    // Otherwise the fix would swallow `finishing` into `idle` and the client
    // would lose the one state it uses to tell "wrapping up" from "idle".
    expect(block).toMatch(/runState === 'finishing'/)
  })
})

/**
 * The client bounds every flag it keeps on its own. The bounds are what end a
 * leak when the terminal event never arrives, so each one is pinned at its use.
 */
describe('every locally-kept light has a bound at its use site', () => {
  it('bounds the delegation count from the snapshot', () => {
    // The count was computed on every poll, used to settle delegation streams,
    // and then dropped -- so the light could be switched on by a socket event and
    // never switched off by anything.
    const apply = chat.slice(chat.indexOf('const backgroundPending = new Map'))
    const block = apply.slice(0, 2000)
    expect(block).toMatch(/setBackgroundPending\(session\.id, pending\)/)
    expect(block).toMatch(/if \(pending === known\) continue/)
  })

  it('puts no clock of its own on whether a run is live', () => {
    // There was one, and it was wrong in both directions. `run_started_at` is
    // when the run *began*, so a window unlit every run that outlived it: a
    // session running for fourteen minutes read identically to a leaked flag and
    // lost its ring while it was still working, next to a three-minute session
    // that lit normally. The reported symptom was exactly that pair.
    const live = chat.slice(chat.indexOf('function isSessionLive'))
    const body = live.slice(0, live.indexOf('\n  }'))
    expect(body).toMatch(/return run\.phase === 'running' \|\| Boolean\(run\.stream\)/)
    // No age arithmetic anywhere in the predicate.
    expect(body).not.toMatch(/Date\.now\(\)/)
    expect(body).not.toMatch(/now - /)
    expect(body).not.toMatch(/STALE_MS/)
  })

  it('keeps the one window that is still meaningful at the veto', () => {
    // The snapshot may only overrule a local flag that is young enough to be a
    // race. That question is about the *snapshot's* freshness, not the run's
    // length, so it survives -- and it must stay short.
    const veto = chat.slice(chat.indexOf('function hasLocalRunEvidence'))
    const vetoBody = veto.slice(0, veto.indexOf('\n  }'))
    expect(vetoBody).toMatch(/now - startedAt < WORKING_SNAPSHOT_FRESHNESS_MS/)
  })

  it('polls while a stream is attached even with no phase', () => {
    // A leftover stream with no phase has nothing else to clear it, so a guard
    // that skipped the poll for it is how a leak becomes permanent.
    // Anchored on the interval that drives the poll, not on the constant, which
    // appears in its own declaration first.
    const guard = chat.slice(chat.indexOf('window.setInterval(() => {', chat.indexOf('const WORKING_SNAPSHOT_POLL_MS')))
    expect(guard.slice(0, 900)).toMatch(/streamStates\.value\.size === 0/)
  })
})
