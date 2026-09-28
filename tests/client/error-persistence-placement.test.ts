import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

/**
 * A retried run made the recorded failure disappear and reappear at a new place
 * in the transcript. The server had in fact persisted the `role: 'error'` row the
 * whole time, so this was a client-side rendering bug, not a persistence bug.
 *
 * Two places dropped or moved it:
 *
 *  - `addAgentErrorMessage` scanned the entire message history and silently
 *    refused to add a failure whenever an identical one already existed, so a
 *    retry produced no new row and the older one stopped being the visible one;
 *  - `mapHermesMessages` deduplicates repeated content per role within a 300s
 *    window, which collapsed two identical persisted `role: 'error'` rows into
 *    one on every transcript re-fetch.
 *
 * The contract these tests pin: a failure is a durable row at the position where
 * it happened. It survives re-fetch, it is never merged into a neighbouring
 * message, and retrying adds another row rather than replacing one. The server
 * still keeps `role: 'error'` out of model context, so the agent never sees it.
 */
const readClient = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('a persisted failure stays where it happened', () => {
  it('never suppresses a new failure because an identical one is in history', () => {
    const store = readClient('stores/hermes/chat.ts')
    const start = store.indexOf('function addAgentErrorMessage')
    expect(start).toBeGreaterThan(-1)
    const body = store.slice(start, store.indexOf('\n  }\n', start))

    // No history scan that can drop the row.
    expect(body).not.toContain('msgs.some(')
    expect(body).not.toContain('LOCAL_ERROR_COALESCE_WINDOW_MS')
    // No rewriting of an earlier bubble, which relocated the error.
    expect(body).not.toContain('last.content === content')
    // No in-place overwrite of a streamed reply.
    expect(body).not.toContain('hasSubstantialContent')
    // The streaming row is only closed, never reused.
    expect(body).toContain("updateMessage(sessionId, last.id, { isStreaming: false })")
    // Every failure is appended as its own row.
    expect(body).toContain("systemType: 'error',")
  })

  it('does not deduplicate persisted error rows when re-reading a transcript', () => {
    const store = readClient('stores/hermes/chat.ts')
    const start = store.indexOf('function mapHermesMessages')
    expect(start).toBeGreaterThan(-1)
    const end = store.indexOf('const toolNameMap', start)
    const body = store.slice(start, end)

    // The per-role dedup exists to undo a kernel bug that writes a duplicate
    // assistant message. It must not extend to failures, or a retried failure
    // erases the earlier record on every refresh.
    expect(body).toContain("if (norm && role !== 'error') {")
    expect(body).toContain('const DEDUP_WINDOW_SEC = 300')
  })

  it('keeps error rows out of the model context server-side', () => {
    const repo = readFileSync('packages/server/src/modules/studio/repositories/session-store.ts', 'utf8')
    // The user sees the failure forever; the agent must never receive it.
    expect(repo).toContain("role IN ('user', 'assistant', 'tool')")
    expect(repo).not.toMatch(/role IN \([^)]*'error'/)
  })
})
