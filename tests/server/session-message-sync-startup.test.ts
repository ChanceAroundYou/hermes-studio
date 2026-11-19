// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `start()` must leave the service running.
 *
 * It used to clear `stopped` and then call `stop()` -- which sets the same flag
 * back to true. The service logged "started", armed its interval, and then bailed
 * on the first line of the sweep, so the periodic reconcile did nothing while
 * every health check said it was fine. A session written by the CLI and never
 * opened stayed stale, and no error was ever produced.
 */
const dbState = vi.hoisted(() => ({ executes: [] as string[], prepared: [] as string[], inserted: [] as any[][] }))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  listProfileNamesFromDisk: () => ['default'],
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const stateDb = vi.hoisted(() => ({ paginated: vi.fn(async (): Promise<any> => null), exact: vi.fn(async (): Promise<any> => null) }))
vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  getSessionDetailPaginatedFromDbWithProfile: stateDb.paginated,
  getExactSessionDetailFromDbWithProfile: stateDb.exact,
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: () => ({
    prepare(sql: string) {
      dbState.prepared.push(sql)
      const flat = sql.replace(/\s+/g, ' ').trim()
      const key = flat.startsWith('SELECT id FROM sessions') ? 'sessionIds'
        : flat.startsWith('SELECT profile FROM sessions') ? 'profile'
        : flat.startsWith('SELECT role, content FROM messages') ? 'mirror'
        : flat.startsWith('INSERT INTO messages') ? 'insert'
        : 'other'
      return {
        all: () => dbState.rows?.get(key) ?? [],
        get: () => (dbState.rows?.get(key) ?? [])[0],
        run: (...args: any[]) => { if (key === 'insert') dbState.inserted.push(args); return { changes: 1 } },
      }
    },
    exec: (sql: string) => { dbState.executes.push(sql) },
    rows: new Map<string, any[]>(),
  }),
}))

import { SessionMessageSync } from '../../packages/server/src/modules/studio/services/session-message-sync'

beforeEach(() => {
  dbState.executes.length = 0
  dbState.prepared.length = 0
  dbState.inserted = []
  stateDb.paginated.mockReset()
  stateDb.exact.mockReset()
})

afterEach(() => {
  SessionMessageSync.getInstance().stop()
  vi.useRealTimers()
})

describe('start() leaves the service able to work', () => {
  it('runs a sweep immediately instead of bailing out', async () => {
    // One session in the mirror with one authoritative message, so the sweep has
    // something real to do. If `stopped` is still true the loop breaks before the
    // first session and nothing is ever read.
    dbState.rows = new Map<string, any[]>([
      ['sessionIds', [{ id: 's1' }]],
      ['profile', [{ profile: 'default' }]],
      ['mirror', []],
    ])
    stateDb.paginated.mockResolvedValue({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] })

    SessionMessageSync.getInstance().start('default')
    // The post-start sweep is fire-and-forget; give it a turn to resolve.
    await new Promise(resolve => setTimeout(resolve, 50))

    // Proof it actually visited the session: it read that session's authoritative
    // rows and opened an insert transaction.
    expect(stateDb.paginated).toHaveBeenCalled()
    expect(dbState.executes).toContain('BEGIN')
    expect(dbState.inserted.length).toBe(1)
  })

  it('keeps the interval armed after starting', () => {
    vi.useFakeTimers()
    const sync = SessionMessageSync.getInstance()
    sync.start('default')
    // A timer that was cleared by the same call would leave this at zero.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })
})
