import type { Message } from '@/stores/hermes/chat'

/**
 * Chronological, consecutive-block grouping — always collapsed.
 * - Merges ANY consecutive `role:'tool'` messages (running/done/error) into one ToolRunCard.
 * - Running is NOT excluded — it is grouped together with done so the spinner
 *   lives inside the same card with identical style, no jump on settle.
 * - Merge ignores runMarker gaps: consecutive tools are merged regardless of
 *   runMarker value, so "two calls not merged" due to differing markers is fixed.
 *   A new assistant/user/command message breaks the chunk, so tools after a new
 *   assistant appear below that text — exactly "same assistant merges, new assistant separates".
 * - Insertion point = chunk[0]'s original index, stable across reload (timestamp-persisted).
 * - Every card default collapsed (ToolRunCard expanded=false).
 * - `ungroupedMessageId` is the search hit being navigated to. Folding it into a
 *   collapsed card would hide the very message the user searched for, so that one
 *   message stays on its own row and breaks the chunk around it.
 */
export function groupCompletedToolsByRun(messages: Message[], ungroupedMessageId?: string | null): Message[] {
  const out: Message[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    const isTool = m.role === 'tool' && !!m.toolName && m.id !== ungroupedMessageId
    if (!isTool) {
      out.push(m)
      i += 1
      continue
    }
    const chunk: Message[] = []
    let j = i
    while (j < messages.length) {
      const cur = messages[j]
      if (cur.role !== 'tool' || !cur.toolName || cur.id === ungroupedMessageId) break
      chunk.push(cur)
      j += 1
    }
    const first = chunk[0]
    const runId = first.runMarker?.trim() || `chunk:${first.id}`
    out.push({
      id: `tool-run:${runId}:${first.id}`,
      role: 'system',
      content: '',
      timestamp: first.timestamp,
      systemType: 'tool-run',
      runMarker: runId,
      toolRunId: runId,
      toolMessages: chunk,
    } as Message)
    i = j
  }
  return out
}
