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

  it('lets the focused message through the filter', () => {
    expect(filterBody).toContain('if (m.id === chatStore.focusMessageId) return true;')
  })

  it('checks the focus before any rule that could drop the row', () => {
    const focusIndex = filterBody.indexOf('if (m.id === chatStore.focusMessageId) return true;')
    expect(focusIndex).toBeGreaterThan(-1)
    for (const rule of ['m.role === "tool"', 'hasRenderableAssistantContent', 'Compression (completed|failed)']) {
      const at = filterBody.indexOf(rule)
      if (at > -1) expect(focusIndex).toBeLessThan(at)
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
