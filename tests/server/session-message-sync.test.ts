// @vitest-environment node
/**
 * A session that also lives in the Hermes Agent `state.db` renders stale here.
 *
 * The WebUI keeps an import-time mirror of such a session. Once the CLI, a
 * cron job or Feishu keeps writing to `state.db`, the mirror stays at the
 * moment it was imported -- so the page shows old messages for a live session,
 * with no error anywhere to explain it.
 *
 * The repair is one-way and additive: fill gaps from `state.db` into the
 * mirror, never delete, never overwrite, never write back. These tests pin the
 * three ways that can go wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbState = vi.hoisted(() => ({
  executes: [] as string[],
  prepared: [] as string[],
  inserted: [] as any[][],
  rows: new Map<string, any[]>(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  listProfileNamesFromDisk: () => ['default'],
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const stateDb = vi.hoisted(() => ({
  paginated: vi.fn(async (): Promise<any> => null),
  exact: vi.fn(async (): Promise<any> => null),
}))

vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  getSessionDetailPaginatedFromDbWithProfile: stateDb.paginated,
  getExactSessionDetailFromDbWithProfile: stateDb.exact,
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: () => ({
    prepare(sql: string) {
      dbState.prepared.push(sql)
      // Match on what the statement is for, not on a character prefix: the
      // production SQL is multi-line, so a prefix match silently returned an
      // empty result for every read and made every case look like a full copy.
      const flat = sql.replace(/\s+/g, ' ').trim()
      const key = flat.startsWith('SELECT profile FROM sessions') ? 'profile'
        : flat.startsWith('SELECT role, content FROM messages') ? 'mirror'
        : flat.startsWith('SELECT id FROM sessions') ? 'sessionIds'
        : flat.startsWith('INSERT INTO messages') ? 'insert'
        : flat.startsWith('UPDATE sessions SET') ? 'metadata'
        : 'other'
      return {
        all: () => dbState.rows.get(key) ?? [],
        get: () => (dbState.rows.get(key) ?? [])[0],
        run: (...args: any[]) => {
          if (key === 'insert') dbState.inserted.push(args)
          return { changes: 1 }
        },
      }
    },
    exec: (sql: string) => { dbState.executes.push(sql) },
  }),
}))

import { SessionMessageSync } from '../../packages/server/src/modules/studio/services/session-message-sync'

function seed(opts: {
  profile?: string
  stateMessages: Array<Record<string, any>>
  mirror?: Array<{ role: string; content: string }>
}) {
  dbState.rows.clear()
  dbState.inserted = []
  dbState.prepared = []
  dbState.executes = []
  // sessions lookup by id
  dbState.rows.set('profile', [{ profile: opts.profile ?? 'default' }])
  // full-history mirror read
  dbState.rows.set('mirror', opts.mirror ?? [])
  stateDb.paginated.mockResolvedValue({ messages: opts.stateMessages })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the mirror is filled from state.db', () => {
  it('inserts the messages the mirror is missing', async () => {
    seed({
      stateMessages: [
        { role: 'user', content: 'hello', timestamp: 100 },
        { role: 'assistant', content: 'hi there', timestamp: 101 },
      ],
      mirror: [{ role: 'user', content: 'hello' }],
    })
    const result = await SessionMessageSync.getInstance().syncSession('s1')
    expect(result.inserted).toBe(1)
    // One transaction, committed: a partial copy would leave the mirror worse
    // than it started.
    expect(dbState.executes).toContain('BEGIN')
    expect(dbState.executes).toContain('COMMIT')
    expect(dbState.executes).not.toContain('ROLLBACK')
  })

  it('keeps duplicate replies that arrive close together', async () => {
    // The Hermes kernel sometimes writes the same assistant row twice. Copying
    // both would show the user a reply they never received twice.
    seed({
      stateMessages: [
        { role: 'assistant', content: 'same answer', timestamp: 100 },
        { role: 'assistant', content: 'same answer', timestamp: 120 },
      ],
      mirror: [],
    })
    const result = await SessionMessageSync.getInstance().syncSession('s2')
    expect(result.inserted).toBe(1)
  })

  it('never collapses repeated user messages', async () => {
    // "继续" sent twice is a legitimate action, not kernel duplication.
    seed({
      stateMessages: [
        { role: 'user', content: '继续', timestamp: 100 },
        { role: 'user', content: '继续', timestamp: 120 },
      ],
      mirror: [],
    })
    const result = await SessionMessageSync.getInstance().syncSession('s3')
    expect(result.inserted).toBe(2)
  })

  it('counts duplicates instead of only checking existence', async () => {
    // An existence-only check hides the second "继续" forever, because the
    // first one already made the key present.
    seed({
      stateMessages: [
        { role: 'user', content: '继续', timestamp: 100 },
        { role: 'user', content: '继续', timestamp: 200 },
      ],
      mirror: [{ role: 'user', content: '继续' }],
    })
    const result = await SessionMessageSync.getInstance().syncSession('s4')
    expect(result.inserted).toBe(1)
  })

  it('never deletes or rewrites what the mirror already has', async () => {
    seed({
      stateMessages: [{ role: 'user', content: 'hello', timestamp: 100 }],
      mirror: [{ role: 'user', content: 'hello' }],
    })
    const result = await SessionMessageSync.getInstance().syncSession('s5')
    expect(result.inserted).toBe(0)
    // The only statements allowed are the metadata refresh; no DELETE, no
    // UPDATE of a message row.
    const writes = dbState.prepared.filter(sql => /^\s*(DELETE|UPDATE\s+messages)/i.test(sql))
    expect(writes).toEqual([])
  })

  it('does not treat whitespace-only differences as new messages', async () => {
    seed({
      stateMessages: [{ role: 'assistant', content: 'answer\n\n', timestamp: 100 }],
      mirror: [{ role: 'assistant', content: 'answer' }],
    })
    const result = await SessionMessageSync.getInstance().syncSession('s6')
    expect(result.inserted).toBe(0)
  })
})

describe('a reconcile that cannot read state.db is a no-op, not a failure', () => {
  it('reports nothing inserted when the read throws', async () => {
    seed({ stateMessages: [] })
    stateDb.paginated.mockRejectedValue(new Error('state.db missing'))
    const result = await SessionMessageSync.getInstance().syncSession('s7')
    expect(result).toEqual({ scanned: 1, missing: 0, inserted: 0, skipped: 0 })
  })

})