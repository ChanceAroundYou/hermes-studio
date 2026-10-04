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
const globalActions = readFileSync(
  'packages/client/src/components/layout/GlobalPendingActions.vue',
  'utf8',
)

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
/**
 * The regression this file's own author introduced.
 *
 * Unifying the surface gave the notification variant `margin: -10px` so the card
 * would sit flush against the toaster frame. `.n-notification` carries a
 * `border-radius`, which clips its content -- so the card was pushed outside the
 * rounded box and, on a real toaster, outside the visible notification entirely.
 *
 * Every other assertion in this file checks that a value equals the value that
 * was chosen. Changing -10px to -20px keeps all of them green while making the
 * window worse. These assert the invariant instead: nothing may push the card out
 * of the frame that has to display it.
 *
 * This mattered because a pending clarify or approval for a session the user is
 * *not* looking at exists in exactly one place: this notification. There is no
 * second surface for it to appear in, so clipping it does not degrade the UI --
 * it silently removes the only way to answer the prompt.
 */
describe('the cross-session prompt cannot be pushed out of its window', () => {
  const notificationRules = () => {
    const out: string[] = []
    const re = /\.pending-interaction-card--notification\s*(?:,[^{]*)?\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(card)) !== null) out.push(m[1])
    return out
  }

  it('never pulls the card outward from the toaster', () => {
    const rules = notificationRules()
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      // Negative margin in any direction moves the card past its container.
      // `margin: -10px` was added to "sit flush inside the toaster" and did the
      // opposite, because the toaster's own border-radius clips the overflow.
      expect(rule).not.toMatch(/-?margin(-top|-right|-bottom|-left)?:\s*-/)
      // A `calc(100% + Npx)` width is the same escape in the other axis.
      expect(rule).not.toMatch(/width:\s*calc\([^)]*\+\s*\d/)
      expect(rule).not.toMatch(/transform:\s*translate[^)]*-\d/)
    }
  })

  it('keeps the window answerable rather than collapsing it', () => {
    const rules = notificationRules()
    for (const rule of rules) {
      // `height: 0` / `opacity` / `visibility: hidden` would hide a prompt the
      // user has no other way to see.
      expect(rule).not.toMatch(/(?<!max-|min-)height:\s*0/)
      expect(rule).not.toMatch(/opacity:\s*0/)
      expect(rule).not.toMatch(/visibility:\s*hidden/)
      // `display: none` on the variant would be the bluntest version of the
      // same bug.
      expect(rule).not.toMatch(/display:\s*none/)
    }
  })

  it('still has a bounded height that leaves room for a scroll', () => {
    // The cap itself is deliberate -- a long question must stay on screen -- so
    // this pins that it exists and that it keeps `overflow-y` for the overflow,
    // rather than banning the value that stops the window running off the page.
    const rules = notificationRules()
    expect(rules.some(rule => /max-height:/.test(rule))).toBe(true)
    expect(rules.some(rule => /overflow-y:\s*auto/.test(rule))).toBe(true)
  })
})

/**
 * The global window is the only surface for a prompt raised by a session the user
 * is not looking at, so the path that fills it must stay session-agnostic.
 *
 * `pendingActions()` walks every pending entry and skips only the one on screen.
 * If it were narrowed to the active session the whole feature would degrade into
 * "you see it once you switch over", which is the report this guards.
 */
describe('the global prompt surface covers every session, not the visible one', () => {
  it('iterates the whole pending map and skips only the visible session', () => {
    expect(globalActions).toMatch(/chatStore\.pendingClarifies\.values\(\)/)
    expect(globalActions).toMatch(/chatStore\.pendingApprovals\.values\(\)/)
    // Suppression is keyed on the visible session only, and is a `continue` --
    // never a filter that could drop unrelated sessions.
    expect(globalActions).toMatch(/if \(pending\.sessionId === visibleChatSessionId\) continue/)
  })

  it('rebuilds the window whenever the pending set changes', () => {
    // Without the watcher the window is built once on mount and a prompt raised
    // later never appears until a reload.
    expect(globalActions).toMatch(/watch\(pendingActions,[\s\S]{0,1200}createGlobalNotification\(action\)/)
    expect(globalActions).toMatch(/\{\s*deep:\s*true,\s*immediate:\s*true\s*\}/)
  })

  it('keeps the prompt un-dismissable and un-expiring', () => {
    // `duration: 0` and `closable: false` are what make it a forced reminder
    // rather than a toast that disappears before it is read.
    expect(globalActions).toMatch(/duration:\s*0/)
    expect(globalActions).toMatch(/closable:\s*false/)
  })
})

/**
 * The stop button and the ring must agree on what "busy" means.
 *
 * `isSessionWorking` is the predicate the sidebar renders from: it counts a live
 * delegation on top of the two foreground flags. `stopStreaming` gated on the
 * two foreground flags alone, so a session busy only through a background
 * delegation showed a lit ring whose stop button returned without emitting
 * anything. Same three sources, fourth reader, different answer.
 *
 * A prompt the user cannot answer is worse than a prompt they can answer slowly:
 * the run is blocked until they open that conversation, and the button gives no
 * indication that it did nothing.
 */
describe('the stop button and the ring agree on what busy means', () => {
  const chat = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')

  const stopGate = () => {
    const start = chat.indexOf('function stopStreaming()')
    const body = chat.slice(start, chat.indexOf('\n  }', start))
    return body
  }

  it('gates on the same predicate the ring renders from', () => {
    const body = stopGate()
    expect(body).toMatch(/if \(!isSessionWorking\(sid\)\) return/)
    // The narrower form is the defect: a delegation-only session has neither
    // foreground flag set, so it would return here and never emit.
    expect(body).not.toMatch(/!streamStates\.value\.has\(sid\) && !serverWorking\.value\.has\(sid\)/)
  })

  it('still refuses when there is nothing to stop', () => {
    // The gate is what prevents a pointless abort on an idle session; it must be
    // a real predicate, not a deleted check.
    expect(chat).toMatch(/function isSessionWorking\(sessionId: string, now = Date\.now\(\)\)/)
    expect(chat).toMatch(/isSessionLive\(sessionId, now\) \|\| \(backgroundPendingBySession\.value\.get\(sessionId\) \|\| 0\) > 0/)
  })
})
