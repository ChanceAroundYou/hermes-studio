import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The session list is ordered by when a session's transcript last grew.
 *
 * It used to be ordered by `MAX(started_at, ended_at, last_active)`, and
 * `ended_at` is when a *run* closed — after a settle delay, usage accounting
 * and a goal-evaluation LLM call that can run for two minutes without emitting
 * a message. So a session that finished at 23:00 but last said something at
 * 20:00 outranked one whose last message arrived at 20:30, which is why the
 * sidebar could look wrong while the database was perfectly consistent.
 */
const store = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/client/src/stores/hermes/chat.ts'),
  'utf8',
)

/** The same formula the store applies, kept here as the executable spec. */
const activityOf = (s: { last_active?: number; started_at?: number }) =>
  s.last_active || s.started_at || 0

describe('sessions are ordered by their last message', () => {
  it('uses last_active and nothing else', () => {
    const helper = store.slice(
      store.indexOf('function sessionActivitySeconds'),
      store.indexOf('function lastVisibleMessage'),
    )
    expect(helper).toContain('s.last_active || s.started_at || 0')
    // The whole point: the run end time must not appear in the formula.
    expect(helper).not.toContain('ended_at')
  })

  it('prefers the later message over the earlier run end', () => {
    const finishedLate = { last_active: 9_000, ended_at: 20_000, started_at: 100 }
    const newerMessage = { last_active: 10_000, ended_at: 10_000, started_at: 200 }

    expect(activityOf(finishedLate)).toBeLessThan(activityOf(newerMessage))
  })

  it('ignores ended_at even when it is far ahead', () => {
    expect(activityOf({ last_active: 1, ended_at: 999_999, started_at: 500 })).toBe(1)
  })

  it('falls back to started_at for a session with no messages', () => {
    expect(activityOf({ last_active: 0, started_at: 5_000 })).toBe(5_000)
    expect(activityOf({ last_active: undefined, started_at: 5_000 })).toBe(5_000)
  })

  it('treats a missing pair as oldest', () => {
    expect(activityOf({})).toBe(0)
  })
})

/**
 * A future client-side bump is the mirror image of the bug: the sidebar would
 * order by something the transcript cannot corroborate.
 */
describe('anti-test: a client-side bump would re-introduce the drift', () => {
  it('a locally invented time outranks a genuinely newer transcript', () => {
    const bumpedLocally = { last_active: Date.now() }
    const actuallyNewer = { last_active: Date.now() - 60_000 }

    expect(activityOf(bumpedLocally)).toBeGreaterThan(activityOf(actuallyNewer))
    // Which is exactly what the user saw: a session promoted to "now" that the
    // server never agreed with.
  })
})
