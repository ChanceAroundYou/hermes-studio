import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Two reports, one cause each, both of which had already been fixed once and
 * then lost again.
 *
 * 1. The thinking avatar jumped up when the queue bar appeared. MessageList
 *    reserved 260px of bottom padding (380px with a prompt as well) for the
 *    floating panels, but those panels are `position: absolute` and the measured
 *    queue panel is 74px tall. a5be9ab79 (2026-09-26) had already flattened the
 *    reservation to a constant; the upstream #3232 merge reinstated the computed,
 *    and the jump came back with it.
 *
 * 2. Clarify and approval prompts looked different and appeared in different
 *    corners. Both had been routed through the shared PendingInteractionCard
 *    (9e91bc25e, 9b0904710, 176706176), but the notification variant was excluded
 *    from the card's own surface, each host carried its own competing copy of the
 *    panel CSS, and the corner was never chosen -- naive-ui's top-right default
 *    fought the conversation card's bottom anchoring.
 *
 * These assertions pin the invariants rather than the pixels, because both
 * regressions came back as someone re-adding a value.
 */

const messageList = readFileSync(
  'packages/client/src/components/hermes/chat/MessageList.vue',
  'utf8',
)
const card = readFileSync(
  'packages/client/src/components/hermes/chat/PendingInteractionCard.vue',
  'utf8',
)
const groupPanel = readFileSync(
  'packages/client/src/components/hermes/group-chat/GroupChatPanel.vue',
  'utf8',
)
const app = readFileSync('packages/client/src/App.vue', 'utf8')

describe('the floating panels never reserve layout space', () => {
  it('does not add bottom padding when a queue or a prompt is visible', () => {
    // The single biggest thing that can bring the jump back is a computed that
    // grows the list padding again.
    expect(messageList).not.toMatch(/virtualListPadding\s*=\s*computed/)
    expect(messageList).toMatch(/const virtualListPadding = "20px"/)
    expect(messageList).not.toMatch(/20px 20px \d{3}px/)
  })

  it('keeps the floating stack out of document flow', () => {
    // If this ever becomes static or relative, the panels would push the
    // conversation even with the padding constant.
    const block = messageList.slice(
      messageList.indexOf('.message-float-stack {'),
      messageList.indexOf('}', messageList.indexOf('.message-float-stack {')),
    )
    expect(block).toContain('position: absolute')
    expect(block).not.toMatch(/position:\s*(static|relative)/)
  })

  it('has no host copy of the card surface that could win by stylesheet order', () => {
    // Both hosts used to re-declare the border, radius and background. The card
    // owns them now; a copy back is how the same prompt renders two ways.
    expect(messageList).not.toMatch(/^\s*\.approval-float-panel\s*[,{]/m)
    expect(groupPanel).not.toMatch(/^\s*\.approval-float-panel\s*[,{]/m)
    expect(messageList).not.toContain('.approval-float-panel--global')
    expect(groupPanel).not.toContain('.approval-float-panel--global')
  })
})

describe('clarify and approval share one card and one corner', () => {
  it('gives every variant the same surface', () => {
    const base = card.slice(card.indexOf('.pending-interaction-card--inline,'))
    const rule = base.slice(0, base.indexOf('}') + 1)
    // All three, not just the notification one: leaving the portal variant out of
    // the shared rule is exactly how a second look sneaks back in.
    expect(rule).toContain('.pending-interaction-card--notification')
    expect(rule).toContain('.pending-interaction-card--portal')
    expect(rule).toContain('.pending-interaction-card--inline')
    // One declaration set: a single border / radius / background.
    expect(rule.match(/border-radius:/g) || []).toHaveLength(1)
    expect(rule.match(/box-shadow:/g) || []).toHaveLength(1)
  })

  it('keeps every variant on the same corner', () => {
    // The portal variant is how realtime voice lifts a card out of the message
    // list, so it stays. What must not drift is the corner: inline is anchored by
    // the float stack, portal by this rule, and the toaster by the provider
    // placement. All three say bottom-right.
    const portalRule = card.slice(card.indexOf('.pending-interaction-card--portal {'))
    const rule = portalRule.slice(0, portalRule.indexOf('}') + 1)
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/right:\s*16px/)
    expect(rule).toMatch(/bottom:\s*16px/)
    expect(messageList).toMatch(/message-float-stack[\s\S]{0,200}right:\s*16px/)
    expect(messageList).toMatch(/message-float-stack[\s\S]{0,200}bottom:\s*16px/)
  })

  it('pins the notification corner instead of inheriting a library default', () => {
    expect(app).toMatch(/<NNotificationProvider\s+placement="[^"]+"/)
  })

  it('still emits a choice so a prompt can be answered', () => {
    // The card lost its portal branch in this pass. If the emit went with it the
    // card would render but silently drop every answer.
    expect(card).toMatch(/defineEmits|emit\('select'/)
    expect(card).toMatch(/['"]select['"]/)
  })
})

describe('option rows have vertical breathing room', () => {
  it('pads the buttons vertically instead of hugging the label', () => {
    const actions = card.slice(
      card.indexOf('.approval-float-actions {'),
      card.indexOf('.clarify-float-input-row'),
    )
    const button = actions.slice(actions.indexOf(':deep(.n-button) {'))
    // A minimum, not just presence: without it, dropping the padding entirely
    // would leave the rule in place and still pass.
    const paddingTop = Number(button.match(/padding-top:\s*(\d+)px/)?.[1] ?? 0)
    const paddingBottom = Number(button.match(/padding-bottom:\s*(\d+)px/)?.[1] ?? 0)
    expect(paddingTop).toBeGreaterThanOrEqual(6)
    expect(paddingBottom).toBeGreaterThanOrEqual(6)
    // The request was padding, not a size. A fixed height would clip a choice
    // that wraps to a second line, which is exactly what d21b49ca0 fixed.
    // `line-height: 1.45` contains the substring `height: 1`, and the hyphen is
    // a word boundary, so the prefixes have to be excluded explicitly or this
    // bans the line-height that makes the wrapped text readable.
    expect(button).not.toMatch(/(?<!max-|min-|line-)height:\s*\d/)
    expect(button).not.toMatch(/min-height:\s*\d/)
    // d21b49ca0's wrapping behaviour must survive the padding change.
    expect(actions).toMatch(/height:\s*auto/)
    expect(actions).toMatch(/flex-wrap:\s*wrap/)
  })

  it('still lets the host copies stay gone', () => {
    // Scoped to the option row on purpose. A blanket search for the 2-column
    // grid also matches `.conversation-switch`, which has nothing to do with
    // this and would make the guard fail for the wrong reason.
    for (const source of [messageList, groupPanel]) {
      const host = source.match(/\.approval-float-actions[^{]*\{[^}]*\}/g) || []
      for (const block of host) {
        expect(block).not.toMatch(/grid-template-columns/)
        expect(block).not.toMatch(/\bwidth:\s*100%/)
      }
    }
  })
})