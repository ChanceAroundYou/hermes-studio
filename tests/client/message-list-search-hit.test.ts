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

  const focusRule = 'if (m.id === chatStore.focusMessageId && !props.hideReasoning) return true;'
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

  // Upstream 226ebc31a (#3571) narrowed the hatch to `&& !props.hideReasoning` so a
  // Person surface that renders no reasoning does not grow an empty bubble for a row
  // it cannot display, and put `props.hideToolCalls` ahead of the hatch in the same
  // breath. That pairing only holds if every surface that hides tool calls also
  // disables the hatch; otherwise the first rule drops the search hit outright.
  it('keeps the hideToolCalls rule paired with the hatch narrowing at every call site', () => {
    expect(filterCallback).toContain('if (props.hideToolCalls && m.role === "tool") return false;')
    const surfaces = readFileSync('packages/client/src/views/hermes/PersonView.vue', 'utf8')
    const mountLines = surfaces.split('\n').filter(line => line.includes('<MessageList'))
    expect(mountLines.length).toBeGreaterThan(0)
    for (const line of mountLines) {
      expect(line).toContain('hide-tool-calls')
      expect(line).toContain('hide-reasoning')
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
