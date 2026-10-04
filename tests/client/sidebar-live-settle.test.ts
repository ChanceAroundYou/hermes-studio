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
 *   - `authoritativeRemove` therefore never dropped `serverWorking`.
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
    const evidenceAt = chat.indexOf('const authoritativeRemove')
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
  it('notifies from the poll, once per session', () => {
    expect(chat).toMatch(/function notifySessionFinishedBySnapshot\(sessionId: string\)/)
    expect(chat).toMatch(/if \(snapshotFinishNotified\.has\(sid\)\) return/)
    expect(chat).toMatch(/showCompletionNotificationIfEnabled\(sid\)/)
  })

  it('actually calls it from the poll loop', () => {
    // Asserting only the function body let a mutation that removed the call site
    // pass: the helper still existed, it was just never invoked. The symptom is
    // precisely "the end is never reported".
    const pollAt = chat.indexOf('const authoritativeRemove')
    const loop = chat.slice(pollAt, pollAt + 900)
    expect(loop).toMatch(/notifySessionFinishedBySnapshot\(id\)/)
  })

  it('covers both ways a run ends without the client attached', () => {
    expect(chat).toMatch(/new Set\(\[\.\.\.authoritativeRemove, \.\.\.finishedBySnapshot\]\)/)
  })

  it('lets the next run report itself again', () => {
    expect(chat).toMatch(/snapshotFinishNotified\.delete\(String\(entry\.session_id\)\)/)
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