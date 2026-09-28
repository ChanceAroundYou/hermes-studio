import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A failed run is part of the transcript. It used to exist only as a bubble the
 * client invented and stashed in localStorage, which meant it disappeared on a
 * reload, never reached a second device, and left the session's activity time
 * frozen at whatever message came before the failure.
 *
 * `role: 'error'` fixes the display and the durability. It must not, however,
 * reach the model: `getSessionContextMessages` selects through a role
 * allowlist, and the anti-test at the bottom asserts that allowlist still
 * excludes it — otherwise the next run would be told about its own failure as
 * if the user had said so.
 */
describe("failures are persisted, shown, and withheld from the model", () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let base = 0
  const at = (offset: number) => base + offset

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'clock', profile: 'default', title: 'clock' })
    base = store.getSession('clock')!.last_active
  })

  afterEach(() => {
    db?.close()
  })

  const messages = (id: string) => (store.getSessionDetail(id)?.messages ?? []) as any[]

  it('stores a failure with the wording the transcript uses', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    const id = store.addMessage({
      session_id: 's1',
      role: 'error',
      content: 'Error: Provider returned 502',
      timestamp: at(1_000),
    })

    expect(id).toBeGreaterThan(0)
    const rows = messages('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      role: 'error',
      content: 'Error: Provider returned 502',
    })
  })

  it('counts a failure as activity', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'go', timestamp: at(1_000) })
    store.addMessage({ session_id: 's1', role: 'error', content: 'Error: boom', timestamp: at(2_000) })

    expect(store.getSession('s1')!.last_active).toBe(at(2_000))
  })

  it('keeps failures out of the rows handed to the model', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'user', content: 'go', timestamp: at(1_000) })
    store.addMessage({ session_id: 's1', role: 'error', content: 'Error: boom', timestamp: at(2_000) })
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'recovered', timestamp: at(3_000) })

    const forContext = store.getSessionContextMessages('s1') as any[]
    expect(forContext.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(forContext.some(m => m.role === 'error')).toBe(false)
  })

  it('leaves the display rows for compression alone too', () => {
    // `command` rows are the compression cards. They are also excluded from
    // context, which is why adding `error` beside them was safe.
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'command', content: 'Compression completed', timestamp: at(1_000) })

    const forContext = store.getSessionContextMessages('s1') as any[]
    expect(forContext).toHaveLength(0)
  })
})

/**
 * The exclusion is a SQL allowlist. If someone widens it, the model starts
 * reading failures as conversation.
 */
describe('anti-test: widening the context allowlist would leak failures', () => {
  let db: any = null
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
  })

  afterEach(() => {
    db?.close()
  })

  it('an error row would be selected if the allowlist admitted it', () => {
    store.createSession({ id: 's1', profile: 'default', title: 't' })
    store.addMessage({ session_id: 's1', role: 'error', content: 'Error: boom', timestamp: 1 })

    // What the real query excludes today.
    expect(store.getSessionContextMessages('s1')).toHaveLength(0)

    // The same read without the allowlist would hand the model a turn the user
    // never typed.
    const widened = db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND role IN ('user','assistant','tool','error')")
      .all('s1')
    expect(widened).toHaveLength(1)
  })
})
