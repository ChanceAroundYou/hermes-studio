import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * Opening a session reads the newest page with
 * `WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`.
 *
 * With only `idx_messages_session_id` on `messages`, SQLite has to read every
 * row the session owns, sort it in a temp B-tree, and discard all but the page.
 * On this database that meant ~555ms per open and 46MB of `content`/`reasoning`
 * touched to return 300 rows, growing with the transcript. The composite index
 * in the query's own sort order makes it a bounded seek: measured 555ms -> 11ms.
 *
 * These assertions pin the index and the query shape, because both are easy to
 * "tidy up" and the cost only shows up once a session has thousands of messages.
 */
const readServer = (path: string) => readFileSync(`packages/server/src/${path}`, 'utf8')

describe('session page reads stay index-backed', () => {
  it('declares a composite index matching the page query sort order', () => {
    const schemas = readServer('modules/studio/infrastructure/database/schemas.ts')

    expect(schemas).toContain('idx_messages_session_page')
    // Column order has to match `ORDER BY timestamp DESC, id DESC` or SQLite
    // falls back to a temp B-tree sort, which is the cost we are removing.
    expect(schemas).toContain(
      'ON messages(session_id, timestamp DESC, id DESC)',
    )
    // Created through the schema bootstrap, not by hand on a live database.
    expect(schemas).toContain('db.exec(MESSAGES_PAGE_INDEX)')
  })

  it('reads a session page in the exact order the index serves', () => {
    const store = readServer('modules/studio/repositories/session-store.ts')
    const start = store.indexOf('export function getSessionDetailPaginated')
    expect(start).toBeGreaterThan(-1)
    const body = store.slice(start, store.indexOf('\n}\n', start))

    // Changing the sort order (or dropping `id`) silently reintroduces the sort.
    expect(body).toContain('ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?')
    // `SELECT *` pulls 46MB of content/reasoning per row scanned; the page is
    // bounded by LIMIT so this is only safe while the index does the filtering.
    expect(body).not.toMatch(/ORDER BY timestamp ASC[^,]*\s*,\s*id ASC[^)]*LIMIT/)
  })
})
