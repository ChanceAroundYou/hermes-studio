import type { Message } from '@/stores/hermes/chat'

/**
 * Chronological, consecutive-block grouping.
 * - Only consecutive `role:'tool' && toolStatus!=='running' && same runMarker` are merged into one ToolRunCard.
 * - Encountering `assistant`/`user`/`command` breaks the chunk, so a new assistant segment gets its own card below it.
 * - Preserves original timestamp order; no global jump to first occurrence.
 * - Insertion point = chunk[0]'s original index, so refresh (timestamp-sorted) stays stable.
 * - Every card default is collapsed (`ToolRunCard expanded=false`), regardless of chunk size.
 */
export function groupCompletedToolsByRun(messages: Message[]): Message[] {
  const out: Message[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    const runId = m.role === 'tool' && m.toolStatus !== 'running' ? m.runMarker?.trim() : undefined
    if (!runId) {
      out.push(m)
      i += 1
      continue
    }
    const chunk: Message[] = []
    let j = i
    while (j < messages.length) {
      const cur = messages[j]
      const curRun = cur.role === 'tool' && cur.toolStatus !== 'running' ? cur.runMarker?.trim() : undefined
      if (curRun !== runId) break
      chunk.push(cur)
      j += 1
    }
    out.push({
      id: `tool-run:${runId}:${chunk[0].id}`,
      role: 'system',
      content: '',
      timestamp: chunk[0].timestamp,
      systemType: 'tool-run',
      runMarker: runId,
      toolRunId: runId,
      toolMessages: chunk,
    } as Message)
    i = j
  }
  return out
}
