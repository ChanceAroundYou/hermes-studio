import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/components/hermes/chat/MessageList.vue', 'utf8')
const liveReasoning = readFileSync('packages/client/src/components/hermes/chat/LiveReasoningStatus.vue', 'utf8')

function rule(name: string): string {
  const start = source.indexOf(`\n.${name} {`)
  expect(start, `.${name} rule not found`).toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end)
}

/** Declarations before the first nested selector, so nested rules do not leak in. */
function topLevelDeclarations(css: string): string {
  return css.split('\n\n')[0]
}

/**
 * The run indicator used to reserve a fixed 120px for a reply that had not
 * arrived, which left the thinking header stranded above a large void once the
 * turn settled. Upstream #3232 replaced this file wholesale and brought the
 * fixed height back; these assertions exist so a future wholesale merge is
 * caught here rather than on a phone.
 */
describe('run indicator keeps no reserved gap', () => {
  it('sizes the run indicator to its content instead of a fixed 120px', () => {
    const css = rule('streaming-indicator')
    expect(css).toContain('flex: 0 0 auto')
    expect(css).toContain('height: auto')
    expect(css).toContain('min-height: 0')
    expect(css).not.toMatch(/height:\s*120px/)
    expect(css).not.toMatch(/flex:\s*0 0 120px/)
  })

  it('stacks the tool panel above the thinking header', () => {
    const toolPanel = source.indexOf('class="tool-calls-panel"')
    const header = source.indexOf('<LiveReasoningStatus')
    expect(toolPanel).toBeGreaterThan(-1)
    expect(header).toBeGreaterThan(-1)
    expect(toolPanel).toBeLessThan(header)
  })

  it('lets the tool panel and its chips grow with the run', () => {
    const panel = rule('tool-calls-panel')
    expect(panel).toContain('flex: 0 0 auto')
    expect(panel).toContain('height: auto')
    expect(panel).not.toMatch(/height:\s*26px/)

    // Nested rules such as .tool-call-preview legitimately keep flex: 1 1 0 to
    // ellipsize inside a chip, so only the chip's own declarations are checked.
    const item = topLevelDeclarations(rule('tool-call-item'))
    expect(item).not.toMatch(/max-height:\s*26px/)
    expect(item).not.toMatch(/flex:\s*1 1 0/)
  })

  it('keeps the reasoning panel above the avatar row', () => {
    const panel = liveReasoning.indexOf('class="live-reasoning-detail"')
    const header = liveReasoning.indexOf('class="thinking-status"')
    expect(panel).toBeGreaterThan(-1)
    expect(header).toBeGreaterThan(-1)
    expect(panel).toBeLessThan(header)
  })

  it('keeps the run block the same distance from the composer as any message', () => {
    // MessageItem separates messages with margin-bottom: 6px.
    const item = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')
    expect(item).toContain('margin-bottom: 6px')

    const css = rule('streaming-indicator')
    expect(css).toContain('padding: 4px 4px 6px 4px')
  })

  it('shows the running tool strip in the bordered card, not a borderless chip', () => {
    expect(source).toContain('<ToolRunSummary')
    expect(source).toContain('class="live-tool-run"')
    // The chip markup that flashed borderless before the run settled.
    expect(source).not.toContain('v-for="tc in visibleToolCalls"')
  })
})
