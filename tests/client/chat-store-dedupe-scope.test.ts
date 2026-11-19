import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The assistant dedupe exists to swallow one kernel double-write, not to compare
 * a new turn against the previous one.
 *
 * Applied across the whole transcript it dropped a legitimate reply whenever an
 * agent answered with the same words twice -- asking it to repeat itself, for
 * example -- and the turn went silent with no error. The window is therefore
 * scoped to the messages after the last user prompt.
 */
const store = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')

describe('assistant dedupe only looks at the turn in progress', () => {
  it('has a turn-scoped view of the transcript', () => {
    expect(store).toMatch(/function messagesInCurrentTurn\(/)
    const at = store.indexOf('function messagesInCurrentTurn')
    const body = store.slice(at, store.indexOf('\n}', at))
    // Anchoring on the last user prompt is what makes it turn-scoped.
    expect(body).toContain("role === 'user'")
    expect(body).toContain('slice(i + 1)')
  })

  it('runs every live dedupe check through that view', () => {
    const calls = store.match(/isDuplicateAssistantContent\([^,]+,\s*'assistant'/g) || []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toMatch(/messagesInCurrentTurn\(/)
    }
  })
})
