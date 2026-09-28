import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Duplicate suppression, and why it now has to treat a failure like any other
 * row.
 *
 * The kernel sometimes writes the same message twice — same text, timestamps
 * minutes apart, often with a tool row wedged between. The store collapses
 * those. A stored failure is subject to exactly the same accident: if the
 * kernel re-emits it, the transcript would show the same red bubble twice.
 *
 * This also pins the property that makes the old design untenable. The client
 * used to keep a *second*, independent copy of every failure in
 * localStorage, and the two copies were reconciled by comparing content
 * strings. The server persisted `send failed` while the client rendered
 * `Error: send failed` — never equal, so the same failure rendered twice. With
 * one authority and identical wording, content comparison is sound again.
 */
const store = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/client/src/stores/hermes/chat.ts'),
  'utf8',
)

/** The algorithm as the store implements it. */
const DEDUP_WINDOW_SEC = 300
const dedupe = (rows: Array<{ role?: string; content: string; timestamp: number }>) => {
  const out: typeof rows = []
  const lastByRole = new Map<string, { norm: string; ts: number }>()
  for (const m of rows) {
    const role = m.role ?? ''
    const norm = m.content.replace(/\s+/g, ' ').trim()
    const ts = m.timestamp ?? 0
    if (norm) {
      const prev = lastByRole.get(role)
      const isDup = !!prev
        && ts >= prev.ts
        && ts - prev.ts < DEDUP_WINDOW_SEC
        && (norm === prev.norm
          || (norm.length > 20 && prev.norm.length > 20
            && (norm.startsWith(prev.norm) || prev.norm.startsWith(norm))))
      if (isDup) continue
      lastByRole.set(role, { norm, ts })
    } else {
      lastByRole.set(role, { norm: '', ts })
    }
    out.push(m)
  }
  return out
}

const err = (content: string, timestamp: number) => ({ role: 'error', content, timestamp })

describe('a repeated failure is shown once', () => {
  it('collapses an identical re-emitted error', () => {
    const rows = [err('Error: Provider returned 502', 1_000), err('Error: Provider returned 502', 1_030)]
    expect(dedupe(rows)).toHaveLength(1)
  })

  it('collapses across an interleaved tool row', () => {
    const rows = [
      err('Error: Provider returned 502', 1_000),
      { role: 'tool', content: 'search', timestamp: 1_010 },
      err('Error: Provider returned 502', 1_020),
    ]
    // The tool row is a different role, so it does not break the run of errors.
    expect(dedupe(rows).filter(r => r.role === 'error')).toHaveLength(1)
  })

  it('keeps two genuinely different failures', () => {
    const rows = [err('Error: Provider returned 502', 1_000), err('Error: session not found', 1_010)]
    expect(dedupe(rows)).toHaveLength(2)
  })

  it('keeps a repeat that arrives long after the first', () => {
    // A user who hits the same problem again an hour later should see it twice.
    const rows = [err('Error: Provider returned 502', 1_000), err('Error: Provider returned 502', 1_000 + DEDUP_WINDOW_SEC + 1)]
    expect(dedupe(rows)).toHaveLength(2)
  })

  it('does not let a failure swallow the user turn that follows it', () => {
    const rows = [
      err('Error: Provider returned 502', 1_000),
      { role: 'user', content: 'try again', timestamp: 1_005 },
    ]
    expect(dedupe(rows)).toHaveLength(2)
  })
})

/**
 * The duplicate that motivated storing the exact wording. When the two
 * authorities disagreed by a prefix, no comparison could ever match.
 */
describe('anti-test: mismatched wording defeats content-based dedup', () => {
  it('server text and client text were never equal', () => {
    const stored = 'send failed'
    const rendered = 'Error: send failed'

    expect(stored).not.toBe(rendered)
    expect(rendered.endsWith(stored)).toBe(true)
    // Which is why reconciliation failed and both copies appeared.
    expect(dedupe([err(stored, 1_000), err(rendered, 1_010)])).toHaveLength(2)
  })

  it('with one authority the same text collapses', () => {
    const both = 'Error: send failed'
    expect(dedupe([err(both, 1_000), err(both, 1_010)])).toHaveLength(1)
  })
})

describe('the store still performs per-role dedup with a sane window', () => {
  it('keeps the algorithm the client actually runs', () => {
    expect(store).toContain('const DEDUP_WINDOW_SEC = 300')
    expect(store).toContain('const lastByRole = new Map<string, { norm: string; ts: number }>()')
  })

  it('counts a role by its own name, so a failure is not compared against a reply', () => {
    // Comparing an error against an assistant reply by content alone would let
    // a quoted error swallow the reply that mentions it.
    const rows = [
      err('Error: Provider returned 502', 1_000),
      { role: 'assistant', content: 'The provider returned 502 earlier.', timestamp: 1_005 },
    ]
    expect(dedupe(rows)).toHaveLength(2)
  })
})
