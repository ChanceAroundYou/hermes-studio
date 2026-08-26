/**
 * Tests for SessionMessageSync — the state.db -> webui mirror reconciler.
 *
 * Covers:
 * 1. user messages are NEVER collapsed (re-sending after a network failure is
 *    legitimate); only assistant messages fold within the dedup window
 * 2. count-aware reconciliation is idempotent (re-running inserts nothing)
 * 3. tail-window gap fill: rows missing at the tail get inserted
 * 4. stop() aborts an in-flight sweep loop
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionDetailPaginatedFromDbWithProfileMock, listProfileNamesFromDiskMock } = vi.hoisted(() => ({
  getSessionDetailPaginatedFromDbWithProfileMock: vi.fn(),
  listProfileNamesFromDiskMock: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbRef.current,
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailPaginatedFromDbWithProfile: (...args: unknown[]) => getSessionDetailPaginatedFromDbWithProfileMock(...args),
  getExactSessionDetailFromDbWithProfile: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  listProfileNamesFromDisk: () => listProfileNamesFromDiskMock(),
}))

const dbRef: { current: any } = { current: null }

interface Row {
  id?: number
  session_id?: string
  role: string
  content: string | null
  tool_call_id?: string | null
  tool_calls?: string | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

function makeStateMsg(role: string, content: string, timestamp: number): Record<string, any> {
  return {
    session_id: 's1',
    role,
    content,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    timestamp,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    reasoning_details: null,
    reasoning_content: null,
  }
}

async function loadSyncClass() {
  const mod = await import('../../packages/server/src/services/hermes/session-message-sync')
  return mod.SessionMessageSync
}

describe('SessionMessageSync.syncSession', () => {
  let db: any

  beforeEach(async () => {
    vi.clearAllMocks()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, profile TEXT, message_count INTEGER DEFAULT 0, last_active INTEGER DEFAULT 0);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp INTEGER NOT NULL,
        token_count INTEGER,
        finish_reason TEXT,
        reasoning TEXT,
        reasoning_details TEXT,
        reasoning_content TEXT
      );
      CREATE INDEX idx_messages_session_id ON messages(session_id);
    `)
    db.prepare("INSERT INTO sessions (id, profile) VALUES ('s1', 'default')").run()
    dbRef.current = db
  })

  afterEach(() => {
    db?.close()
    dbRef.current = null
  })

  function webuiRows(): Array<{ id: number; role: string; content: string }> {
    return db.prepare('SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id').all('s1')
  }

  it('inserts two identical user messages without collapsing either', async () => {
    const SessionMessageSync = await loadSyncClass()
    const sync = new SessionMessageSync()
    const t0 = Date.now() / 1000
    getSessionDetailPaginatedFromDbWithProfileMock.mockResolvedValue({
      messages: [
        makeStateMsg('user', '继续', t0),
        makeStateMsg('assistant', '好的', t0 + 5),
        makeStateMsg('user', '继续', t0 + 10),
      ],
    })

    const result = await sync.syncSession('s1')

    expect(result.inserted).toBe(3)
    const rows = webuiRows()
    expect(rows.filter(r => r.role === 'user' && r.content === '继续')).toHaveLength(2)
    expect(rows.filter(r => r.role === 'assistant')).toHaveLength(1)
  })

  it('collapses a duplicated assistant reply within the window but keeps distinct ones', async () => {
    const SessionMessageSync = await loadSyncClass()
    const sync = new SessionMessageSync()
    const t0 = Date.now() / 1000
    // Kernel-duplication pattern: identical assistant content twice <300s apart.
    getSessionDetailPaginatedFromDbWithProfileMock.mockResolvedValue({
      messages: [
        makeStateMsg('assistant', '同样的回复', t0),
        makeStateMsg('assistant', '同样的回复', t0 + 60),
        makeStateMsg('assistant', '同样的回复', t0 + 400), // outside window -> kept
      ],
    })

    const result = await sync.syncSession('s1')

    expect(result.inserted).toBe(2)
    const rows = webuiRows().filter(r => r.role === 'assistant' && r.content.includes('同样的回复'))
    expect(rows).toHaveLength(2)
  })

  it('is idempotent: re-running with the same state.db rows inserts nothing', async () => {
    const SessionMessageSync = await loadSyncClass()
    const sync = new SessionMessageSync()
    const t0 = Date.now() / 1000
    const stateMessages = [
      makeStateMsg('user', 'hello', t0),
      makeStateMsg('assistant', 'world', t0 + 3),
    ]
    getSessionDetailPaginatedFromDbWithProfileMock.mockResolvedValue({ messages: stateMessages })

    const first = await sync.syncSession('s1')
    expect(first.inserted).toBe(2)

    const second = await sync.syncSession('s1')
    expect(second.inserted).toBe(0)
    expect(webuiRows()).toHaveLength(2)
  })

  it('fills a tail gap when state.db has newer messages than the mirror', async () => {
    const SessionMessageSync = await loadSyncClass()
    const sync = new SessionMessageSync()
    const t0 = Date.now() / 1000

    // Mirror already holds the first two rows (as if imported earlier).
    const insert = db.prepare(`INSERT INTO messages
      (session_id, role, content, timestamp) VALUES (?,?,?,?)`)
    insert.run('s1', 'user', 'old question', Math.floor(t0 - 60))
    insert.run('s1', 'assistant', 'old answer', Math.floor(t0 - 30))

    getSessionDetailPaginatedFromDbWithProfileMock.mockResolvedValue({
      messages: [
        makeStateMsg('user', 'old question', t0 - 60),
        makeStateMsg('assistant', 'old answer', t0 - 30),
        makeStateMsg('user', 'new question', t0 + 10),
        makeStateMsg('assistant', 'new answer', t0 + 20),
      ],
    })

    const result = await sync.syncSession('s1')

    expect(result.inserted).toBe(2)
    const contents = webuiRows().map(r => r.content)
    expect(contents).toEqual(['old question', 'old answer', 'new question', 'new answer'])
    // Mirror metadata updated from inserted rows.
    const sess = db.prepare("SELECT message_count, last_active FROM sessions WHERE id = 's1'").get() as any
    expect(sess.message_count).toBe(4)
  })

  it('stop() aborts an in-flight sweep loop between sessions', async () => {
    const SessionMessageSync = await loadSyncClass()
    const sync = new SessionMessageSync()

    // Two sessions in the active window; the first syncSession call flips stopped.
    db.prepare("INSERT INTO sessions (id, profile) VALUES ('s2', 'default')").run()
    let calls = 0
    getSessionDetailPaginatedFromDbWithProfileMock.mockImplementation(async () => {
      calls += 1
      if (calls === 1) sync.stop()
      return { messages: [makeStateMsg('user', `m${calls}`, Date.now() / 1000)] }
    })
    vi.spyOn(sync as any, 'syncSession')

    const result = await sync.sweepActive(false)

    // Loop broke after stop() flipped mid-first-iteration; second session untouched.
    expect(calls).toBeLessThan(2)
    void result
  })
})
