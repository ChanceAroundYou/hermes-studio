// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '../..')
const globalScss = readFileSync(resolve(repo, 'packages/client/src/styles/global.scss'), 'utf8')
const chatPanel = readFileSync(resolve(repo, 'packages/client/src/components/hermes/chat/ChatPanel.vue'), 'utf8')

/**
 * The chat header lines its (title + workspace) block up on the centre line of
 * the control to its left: the grid button on desktop, the menu button on
 * mobile. That only stays true while both sides are sized from the same CSS
 * variables, so these tests pin the contract rather than the pixels.
 */
describe('chat header identity geometry', () => {
  it('defines the menu button geometry once, on :root', () => {
    expect(globalScss).toMatch(/--app-menu-btn-size:\s*36px/)
    expect(globalScss).toMatch(/--app-menu-btn-top:\s*calc\(10px \+ env\(safe-area-inset-top, 0px\)\)/)
    expect(globalScss).toMatch(/--app-menu-btn-inset:\s*12px/)
  })

  it('sizes the menu button from those variables, not from literals', () => {
    const rule = globalScss.match(/^\.hamburger-btn \{([\s\S]*?)\n\}/m)?.[1] ?? ''
    expect(rule).toMatch(/top:\s*var\(--app-menu-btn-top\)/)
    expect(rule).toMatch(/left:\s*var\(--app-menu-btn-inset\)/)
    expect(rule).toMatch(/width:\s*var\(--app-menu-btn-size\)/)
    expect(rule).toMatch(/height:\s*var\(--app-menu-btn-size\)/)
    // A literal here would silently drift away from the header.
    expect(rule).not.toMatch(/top:\s*calc\(10px/)
    expect(rule).not.toMatch(/width:\s*36px/)
  })

  it('gives the identity block the same height as the menu button', () => {
    expect(chatPanel).toMatch(/\.header-identity \{[\s\S]*?min-height:\s*var\(--app-menu-btn-size\)/)
    // Centred, so a shorter (badge-less) block still sits on the same centre.
    expect(chatPanel).toMatch(/\.header-identity \{[\s\S]*?justify-content:\s*center/)
  })

  it('starts the mobile header where the menu button starts', () => {
    // Take the media block that actually contains `.chat-header`; the file has
    // several and the first one is not it.
    const mobile = [...chatPanel.matchAll(/@media \(max-width: \$breakpoint-mobile\) \{[\s\S]*?\n\}/g)]
      .map(match => match[0])
      .find(block => block.includes('.chat-header')) ?? ''
    expect(mobile).toMatch(/padding:\s*var\(--app-menu-btn-top\)/)
    // 12px inset + 36px button + 8px clearance.
    expect(mobile).toMatch(/calc\(var\(--app-menu-btn-inset\) \+ var\(--app-menu-btn-size\) \+ 8px\)/)
  })

  it('indents the title by the badge inset only, so it clears the folder icon', () => {
    const identity = chatPanel.match(/^\.header-identity \{([\s\S]*?)\n\}/m)?.[1] ?? ''
    const badge = chatPanel.match(/^\.workspace-badge \{([\s\S]*?)\n\}/m)?.[1] ?? ''

    // The badge's metrics live on the block, once.
    const metric = (name: string) =>
      Number(identity.match(new RegExp(`--ws-badge-${name}:\\s*(\\d+)px`))?.[1] ?? NaN)
    expect(metric('pad')).toBe(8)
    expect(metric('icon')).toBe(12)
    expect(metric('gap')).toBe(4)

    // The title clears the badge's INSET only: its left edge meets the folder
    // icon's left edge. Indenting by pad+icon+gap instead would line the title
    // up with the "workspace" text, which reads as too much indent.
    const indent = chatPanel.match(
      /^\.header-identity--with-workspace \.header-session-title \{([\s\S]*?)\n\}/m,
    )?.[1] ?? ''
    expect(indent).toMatch(/padding-inline-start: var\(--ws-badge-pad\)/)
    // The old over-indent must not come back in any form.
    expect(chatPanel).not.toMatch(/--ws-badge-lead/)
    expect(chatPanel).not.toMatch(/padding-inline-start: var\(--ws-badge-icon\)/)

    // And the badge consumes the same variables, so the two cannot drift.
    expect(badge).toMatch(/padding: 1px var\(--ws-badge-pad\)/)
    expect(badge).toMatch(/gap: var\(--ws-badge-gap\)/)
    expect(badge).toMatch(/inline-size: var\(--ws-badge-icon\)/)
  })

  it('keeps title + gap + badge summing to the button height', () => {
    // 18px title line + 2px gap + 16px badge == 36px == --app-menu-btn-size.
    // If any of these change the block stops being exactly one button tall and
    // the centre-line alignment drifts.
    const title = chatPanel.match(/^\.header-session-title \{([\s\S]*?)\n\}/m)?.[1] ?? ''
    const badge = chatPanel.match(/^\.workspace-badge \{([\s\S]*?)\n\}/m)?.[1] ?? ''
    const identity = chatPanel.match(/^\.header-identity \{([\s\S]*?)\n\}/m)?.[1] ?? ''

    // Anchored to a declaration so `--ws-badge-gap: 4px` is not read as `gap`.
    const px = (src: string, prop: string) =>
      Number(src.match(new RegExp(`^\\s*${prop}:\\s*(\\d+)px`, 'm'))?.[1] ?? NaN)
    const titleLine = px(title, 'line-height')
    const gap = px(identity, 'gap')
    const badgeHeight = px(badge, 'line-height') + 2 * px(badge, 'padding')

    expect(titleLine).toBe(18)
    expect(gap).toBe(2)
    expect(badgeHeight).toBe(16)
    expect(titleLine + gap + badgeHeight).toBe(36)
  })
})
