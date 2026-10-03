import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The option row of PendingInteractionCard must size itself to its own label.
 *
 * Three copies of `.approval-float-actions` used to exist: one in the card and
 * one in each host (MessageList, GroupChatPanel). The host copies re-imposed
 * `grid-template-columns: repeat(2, minmax(0, 1fr))` plus `width: 100%` on
 * `.n-button`, so a long clarification choice was pinned into half the row,
 * clipped instead of wrapping, and its height never grew. Whichever stylesheet
 * loaded last won, which made the symptom depend on import order.
 *
 * The card is now the only owner. This asserts that, and that the owning rule
 * carries the two declarations that make a long option readable.
 */
const read = (path: string) => readFileSync(path, 'utf8')

const card = read('packages/client/src/components/hermes/chat/PendingInteractionCard.vue')
const messageList = read('packages/client/src/components/hermes/chat/MessageList.vue')
const groupPanel = read('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue')

/**
 * The body of a top-level rule, brace-balanced.
 *
 * A plain `indexOf('}')` truncates at the first closing brace, which here is
 * the end of the nested `:deep(...)` block rather than the rule itself -- that
 * silently produced an empty body and two failures. Walk the nesting depth.
 */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  expect(start, `${selector} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i)
    }
  }
  throw new Error(`unbalanced rule: ${selector}`)
}

describe('clarification options size themselves', () => {
  it('is owned solely by the shared card', () => {
    // A host copy can only reintroduce the fixed grid, so its absence is the
    // actual invariant -- more robust than asserting the card is correct.
    expect(messageList).not.toContain('.approval-float-actions')
    expect(groupPanel).not.toContain('.approval-float-actions')
  })

  it('never pins options into fixed columns', () => {
    for (const [name, source] of [['MessageList', messageList], ['GroupChatPanel', groupPanel]] as const) {
      expect(source, `${name} reintroduced a fixed option grid`).not.toMatch(
        /approval-float-actions[\s\S]{0,200}repeat\(2/,
      )
    }
  })

  it('lets the buttons wrap and grow with their label', () => {
    const body = ruleBody(card, '.approval-float-actions')
    expect(body).toContain('flex-wrap: wrap')
    // `n-button)` also matches `n-button__content)`, where max-width:100% is
    // correct, so anchor on the brace.
    const buttonRule = /:deep\(\.n-button\)\s*\{([^}]*)\}/.exec(body)
    expect(buttonRule, 'the button sizing rule is missing').toBeTruthy()
    const button = buttonRule![1]
    // `max-width` contains `width`, so anchor on the declaration start.
    // width:100% inside a fixed column is what forced the clipping.
    expect(button).not.toMatch(/(^|[;{\s])width:\s*100%/)
    expect(button).toMatch(/(^|[;{\s])width:\s*auto/)
    // A fixed height is the other half of "height never changes".
    expect(button).toMatch(/height:\s*auto/)
  })

  it('wraps the label text instead of truncating it', () => {
    const body = ruleBody(card, '.approval-float-actions')
    const content = /:deep\(\.n-button__content\)\s*\{([^}]*)\}/.exec(body)
    expect(content, 'the label rule is missing').toBeTruthy()
    expect(content![1]).toMatch(/white-space:\s*normal/)
    // anywhere so a single unbroken token still wraps rather than overflowing.
    expect(content![1]).toMatch(/overflow-wrap:\s*anywhere/)
  })
})
