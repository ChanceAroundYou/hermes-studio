import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * Search navigation has to survive the transcript's own display filters.
 *
 * A search hit is usually an old message, and the list drops rows it cannot
 * render: tool messages while the trace is collapsed, assistant turns with no
 * renderable content, and the synthetic `/compress` rows once a compression
 * card is showing. Any of those would swallow the exact message the user asked
 * to jump to, and the view would scroll to nothing with no error.
 *
 * The filter therefore lets the focused id through before every other rule. It
 * is read from the component source because the filter is a closure over store
 * state; asserting the real rule keeps this from drifting into a comment.
 */
const source = readFileSync(
  'packages/client/src/components/hermes/chat/MessageList.vue',
  'utf8',
)

describe('the transcript keeps the message a search navigated to', () => {
  const filterStart = source.indexOf('const renderedMessages = messages')
  const filterBody = source.slice(filterStart, source.indexOf('const displayMessagesWithForkDivider', filterStart))

  // This branch's MessageList has no `hideReasoning` prop, so the hatch is
  // unconditional: the focused row is always let through.
  const focusRule = 'if (m.id === chatStore.focusMessageId) return true;'
  // The filter callback alone. The grouping call at the end of the same computed also
  // names focusMessageId, and counting the whole computed would let a second hatch
  // appear in the filter unnoticed.
  const filterCallback = filterBody.slice(
    filterBody.indexOf('.filter('),
    filterBody.indexOf('.map('),
  )

  it('lets the focused message through the filter', () => {
    expect(filterCallback).toContain(focusRule)
  })

  it('checks the focus before the rules that hide a row on content', () => {
    const focusIndex = filterCallback.indexOf(focusRule)
    expect(focusIndex).toBeGreaterThan(-1)
    // toolTraceVisible collapses every tool row, and hasRenderableAssistantContent
    // drops empty assistant rows: both would swallow the message the user asked to
    // jump to. hideToolCalls is a deliberate surface-level choice, checked separately.
    for (const rule of ['toolTraceVisible.value', 'hasRenderableAssistantContent(m)']) {
      const at = filterCallback.indexOf(rule)
      expect(at).toBeGreaterThan(-1)
      expect(focusIndex).toBeLessThan(at)
    }
  })

  // The hatch is per-row and comes first, so no later rule can swallow the search
  // hit: this branch narrows the assistant rows by "has renderable content"
  // rather than by a per-surface reasoning flag.
  it('keeps the focus check ahead of every rule that hides a row', () => {
    const focusIndex = filterCallback.indexOf(focusRule)
    expect(focusIndex).toBeGreaterThan(-1)
    for (const rule of ['m.role === "tool"', 'hasRenderableAssistantContent(m)']) {
      const at = filterCallback.indexOf(rule)
      expect(at).toBeGreaterThan(-1)
      expect(focusIndex).toBeLessThan(at)
    }
  })

  it('still applies the normal filters to every other message', () => {
    // The escape hatch is per-message, not a blanket "show everything".
    expect(filterBody).toContain('hasRenderableAssistantContent(m)')
  })

  it('keeps the search hit out of the collapsed tool card', () => {
    expect(source).toContain(
      'groupCompletedToolsByRun(positionTaskPlansAtTurnEnd(renderedMessages), chatStore.focusMessageId)',
    )
  })
})
