import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * One session, one record, one writer.
 *
 * This state used to live in five parallel maps keyed by session id --
 * `streamStates`, `serverWorking`, `runStates`, `backgroundPendingBySession`,
 * `runStartedAt` -- plus the run id. Every symptom that came back was a
 * disagreement between them:
 *
 *   - a ring stayed lit because `reconcileSessionIdle` cleared three of the six
 *     fields and left the phase holding `running`;
 *   - a stop named a run that had already been replaced, because the id was
 *     recorded only where the flag was first set;
 *   - a snapshot entry that said `idle` lit the ring, because membership of the
 *     snapshot was read as "busy".
 *
 * Each was fixed on its own, more than once, and came back. The structure was
 * the cause, so the structural invariants are what is asserted here. The
 * behaviour of the record lives in session-run-record.test.ts, which has a DOM.
 */

const chat = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')

describe('nothing writes through a projection', () => {
  /**
   * The dangerous shape, and the reason this file exists.
   *
   * `serverWorking`, `streamStates`, `runStartedAt` and
   * `backgroundPendingBySession` are `computed` views of the record now. A
   * computed caches its value, so `serverWorking.value.add(sid)` *appears* to
   * work -- it mutates the cached Set -- and then silently stops having any
   * effect the moment anything invalidates that computed. TypeScript accepts it,
   * no test fails, and the state quietly stops changing.
   *
   * Twenty-eight call sites looked exactly like that after the merge. All of
   * them are gone; this keeps them gone.
   */
  it('has no write calls on the derived views', () => {
    const writes = chat.match(
      /(?:serverWorking|streamStates|runStartedAt|backgroundPendingBySession)\.value\.(?:add|delete|set|clear)\(/g,
    ) || []
    expect(writes).toEqual([])
  })

  it('declares every one of them as a computed over the record', () => {
    // If one goes back to being a `ref`, it is a second source of truth again and
    // the whole point is lost -- even though nothing would fail immediately.
    for (const name of ['serverWorking', 'streamStates', 'runStartedAt', 'backgroundPendingBySession']) {
      expect(chat).toMatch(new RegExp('const ' + name + ' = computed'))
      expect(chat).not.toMatch(new RegExp('const ' + name + ' = ref'))
    }
  })
})

describe('the record has exactly one writer', () => {
  it('changes an entry only from patchSessionRun', () => {
    // Two assignments inside the writer, and two generation resets that clear
    // the whole record outright. Any other per-session write would be a second
    // mechanism again.
    const assignments = chat.match(/sessionRuns\.value = /g) || []
    expect(assignments).toHaveLength(4)
    const writer = chat.slice(chat.indexOf('function patchSessionRun'))
    const writerBody = writer.slice(0, writer.indexOf('\n  }'))
    expect(writerBody).toMatch(/sessionRuns\.value = new Map\(sessionRuns\.value\)\.set\(sid, next\)/)
    expect(writerBody).toMatch(/sessionRuns\.value = copy/)
  })

  it('clears every field when it converges to idle', () => {
    // The reported sticky ring: clearing three of six fields left the phase
    // behind, and `hasRecentRunStart` trusts a run with no recorded start -- so
    // the ring stayed lit after reconciling.
    const fn = chat.slice(chat.indexOf('function markSessionIdle'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    for (const field of ['phase', 'runId', 'startedAt', 'stream']) {
      expect(body).toContain(field + ':')
    }
    // Delegations survive on purpose: a delegation outlives its run.
    expect(body).not.toContain('delegations')
  })

  it('keeps the idle path going through it', () => {
    const fn = chat.slice(chat.indexOf('function reconcileSessionIdle'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    expect(body).toMatch(/markSessionIdle\(sid\)/)
    expect(body).not.toMatch(/(?:serverWorking|streamStates|runStates)\.value\.delete/)
  })

  it('has no surviving code reference to the maps it replaced', () => {
    // `runStates` and `liveRunIds` were removed outright. The names survive in
    // comments that explain what was replaced, which is the point -- so this
    // looks for code, not for the word.
    expect(chat).not.toMatch(/runStates\.value/)
    expect(chat).not.toMatch(/const runStates = /)
    expect(chat).not.toMatch(/liveRunIds/)
  })
})
