import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Persistence is the point: without it a restart makes the process relearn, and
 * a provider that rejected `max` yesterday rejects it again today.
 */
describe('reasoning effort capability persistence', () => {
  let db: any

  beforeEach(() => {
    vi.resetModules()
    db = null
  })

  async function withDatabase() {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import(
      '../../packages/server/src/modules/studio/infrastructure/database/schemas'
    )
    initAllHermesTables()
    return import('../../packages/server/src/modules/studio/repositories/reasoning-effort-capability-store')
  }

  it('creates its table on first use', async () => {
    const store = await withDatabase()
    store.saveEffortCapability('deepseek', 'deepseek-v4', ['low', 'medium'], ['high'])
    const rows = db
      .prepare('SELECT provider, model, supported, rejected FROM reasoning_effort_capabilities')
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4', rejected: 'high' })
  })

  it('upserts rather than duplicating a deployment', async () => {
    const store = await withDatabase()
    store.saveEffortCapability('deepseek', 'v4', ['low'], [])
    store.saveEffortCapability('deepseek', 'v4', ['low', 'medium'], ['high'])
    const rows = db.prepare('SELECT supported, rejected FROM reasoning_effort_capabilities').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ supported: 'low,medium', rejected: 'high' })
  })

  it('round-trips through load', async () => {
    const store = await withDatabase()
    store.saveEffortCapability('openai', 'gpt-5', ['high'], ['xhigh'])
    const seen: string[] = []
    store.registerEffortCapabilityHooks({
      hydrate: (provider, model, supported, rejected) => seen.push(`${provider}/${model}:${supported.join('|')}:${rejected.join('|')}`),
      persist: () => {},
    })
    expect(store.loadEffortCapabilities()).toBe(1)
    expect(seen).toEqual(['openai/gpt-5:high:xhigh'])
  })

  it('returns zero and does not throw when the database is unavailable', async () => {
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => null,
      getStoragePath: () => ':memory:',
    }))
    const store = await import(
      '../../packages/server/src/modules/studio/repositories/reasoning-effort-capability-store'
    )
    expect(() => store.saveEffortCapability('p', 'm', ['low'], [])).not.toThrow()
    expect(store.loadEffortCapabilities()).toBe(0)
  })

  it('keeps serving when the write fails', async () => {
    const store = await withDatabase()
    db.close()  // every subsequent write now fails
    expect(() => store.saveEffortCapability('deepseek', 'v4', ['low'], [])).not.toThrow()
  })

  it('forgets a deployment on request', async () => {
    const store = await withDatabase()
    store.saveEffortCapability('deepseek', 'v4', ['low'], [])
    store.clearEffortCapability('deepseek', 'v4')
    expect(db.prepare('SELECT COUNT(*) AS n FROM reasoning_effort_capabilities').get()).toMatchObject({ n: 0 })
  })
})
