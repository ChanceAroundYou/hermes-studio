import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A refresh may not rebuild the transcript from scratch.
 *
 * `mapHermesMessages` takes the rows already on screen so it can keep their
 * identity and their client-only fields. Passing an empty list threw both away:
 * the same reply came back as a new object with a new id, which made the voice
 * stage read a finished answer out loud again and made settled tool rows look
 * as if they had never been settled. The consequence is easy to miss because
 * nothing errors -- the transcript simply looks rebuilt.
 */
const store = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')

describe('a foreground refresh keeps the rows it already has', () => {
  it('merges the fetched page against the live transcript', () => {
    const at = store.indexOf('async function refreshActiveSession')
    expect(at).toBeGreaterThan(-1)
    const body = store.slice(at, store.indexOf('\n  }', at))

    // The third argument is the previous rows. Read the one call in this
    // function, so a literal empty array there is the only thing that fails.
    const calls = body.match(/mapHermesMessages\([^)]*\)/g) || []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toMatch(/target\.messages\)$/)
    }
  })
})
