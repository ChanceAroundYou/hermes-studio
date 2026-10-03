/**
 * Persisted compression records.
 *
 * A compression permanently discards context, so "it happened here" is a fact
 * about the conversation and belongs in the transcript. It used to exist only as
 * a live banner inside the run indicator, which is gated on the run being live:
 * the moment a run settled the notice vanished, and a re-fetched transcript never
 * had it at all.
 *
 * Stored as a `command` row carrying `display_role: 'compression'` and a JSON
 * payload, rather than as prose:
 *
 *   - `role: 'command'` keeps it out of model context for free. The context
 *     whitelist is `role IN ('user', 'assistant', 'tool')`, so no extra filtering
 *     is needed and the row can never be replayed to the provider.
 *   - The structured payload is what lets the client render one entry that
 *     updates in place from "Compressing..." to the final numbers, instead of
 *     matching on the text of a sentence.
 *   - Prose is kept in `display_content` so the row stays readable in the history
 *     view and to anything that does not parse the payload.
 *
 * Keyed on `startedAt`, which is when the compression actually began rather than
 * when the completion event arrived. The client's live entry uses the same key,
 * so the live notice and the persisted row collapse into a single line instead of
 * showing one compression twice.
 */
import { addMessage } from '../../repositories/session-store'

/** Stable marker the client keys on. Changing it orphans existing rows. */
export const COMPRESSION_DISPLAY_ROLE = 'compression'

export interface CompressionRecordPayload {
  messageCount: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean | null
  error?: string
  source?: string
  startedAt: number
}

export function serializeCompressionRecord(payload: CompressionRecordPayload): string {
  return JSON.stringify({ __compression: payload })
}

export function parseCompressionRecord(content: string): CompressionRecordPayload | null {
  const trimmed = (content ?? '').trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    const payload = parsed?.__compression
    if (!payload || typeof payload !== 'object') return null
    if (typeof payload.startedAt !== 'number') return null
    return payload as CompressionRecordPayload
  } catch {
    return null
  }
}

/** The same sentence the previous plain-text command message carried. */
export function compressionRecordText(payload: CompressionRecordPayload): string {
  if (payload.error) return `Compression failed: ${payload.error}`
  if (payload.compressed === false) return 'Compression skipped'
  return `Compressed ${payload.messageCount} msgs: ${payload.beforeTokens} -> ${payload.afterTokens} tokens`
}

/**
 * Writes the persisted row. Called once per compression, from both the
 * `/compact` command path and the automatic mid-run path, so the two look
 * identical in the transcript.
 *
 * `timestamp` is `startedAt` in seconds because that is the DB's unit, and it is
 * what places the row between the messages the compression actually sat between.
 */
export function persistCompressionRecord(
  sessionId: string,
  state: { messages?: unknown[] },
  payload: CompressionRecordPayload,
): number | undefined {
  const startedAtSeconds = Math.floor(payload.startedAt / 1000)
  const content = serializeCompressionRecord(payload)
  const displayContent = compressionRecordText(payload)
  const id = addMessage({
    session_id: sessionId,
    role: 'command',
    display_role: COMPRESSION_DISPLAY_ROLE,
    content,
    display_content: displayContent,
    timestamp: startedAtSeconds,
  })
  // The in-process session mirror feeds resumes, so the row has to land there
  // too, or the next attach would drop it until a full re-fetch.
  if (state?.messages) {
    state.messages.push({
      id: id ?? `compression_${startedAtSeconds}_${state.messages.length}`,
      session_id: sessionId,
      role: 'command',
      display_role: COMPRESSION_DISPLAY_ROLE,
      content,
      display_content: displayContent,
      timestamp: startedAtSeconds,
    })
  }
  return id
}
