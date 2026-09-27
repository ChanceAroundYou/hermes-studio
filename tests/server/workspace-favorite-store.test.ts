import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Favourites are account-scoped server state, so the two things that matter are
 * that one user cannot see or clobber another's list, and that a second browser
 * for the same account reads exactly what the first one wrote.
 */
describe('workspace favourite store', () => {
  let db: any = null

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
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function store() {
    return import('../../packages/server/src/modules/studio/repositories/workspace-favorite-store')
  }

  it('keeps each account list separate', async () => {
    const { addWorkspaceFavorite, listWorkspaceFavorites, removeWorkspaceFavorite } = await store()

    addWorkspaceFavorite(1, '/home/alice/work')
    addWorkspaceFavorite(2, '/home/bob/work')

    expect(listWorkspaceFavorites(1).map(e => e.path)).toEqual(['/home/alice/work'])
    expect(listWorkspaceFavorites(2).map(e => e.path)).toEqual(['/home/bob/work'])

    removeWorkspaceFavorite(1, '/home/alice/work')
    expect(listWorkspaceFavorites(2).map(e => e.path)).toEqual(['/home/bob/work'])
  })

  it('is idempotent, so a double tap does not duplicate a row', async () => {
    const { addWorkspaceFavorite, listWorkspaceFavorites } = await store()

    addWorkspaceFavorite(1, '/home/u/work')
    addWorkspaceFavorite(1, '/home/u/work')

    expect(listWorkspaceFavorites(1)).toHaveLength(1)
  })

  it('treats a trailing separator as the same directory', async () => {
    const { addWorkspaceFavorite, listWorkspaceFavorites, isWorkspaceFavorite } = await store()

    addWorkspaceFavorite(1, '/home/u/work')
    expect(isWorkspaceFavorite(1, '/home/u/work/')).toBe(true)
    expect(listWorkspaceFavorites(1)).toHaveLength(1)
  })

  it('rejects an empty path and removes a missing row without throwing', async () => {
    const { addWorkspaceFavorite, removeWorkspaceFavorite } = await store()

    expect(() => addWorkspaceFavorite(1, '   ')).toThrow()
    expect(removeWorkspaceFavorite(1, '/never/favourited')).toBe(false)
  })

  it('preserves the order rows were added in', async () => {
    const { addWorkspaceFavorite, listWorkspaceFavorites } = await store()

    addWorkspaceFavorite(1, '/a')
    addWorkspaceFavorite(1, '/b')
    addWorkspaceFavorite(1, '/c')

    expect(listWorkspaceFavorites(1).map(e => e.path)).toEqual(['/a', '/b', '/c'])
  })
})

describe('per-profile default workspace', () => {
  let db: any = null

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
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('stores one default per profile, independently', async () => {
    const { setProfileWorkspace, getProfileWorkspace, replaceUserProfiles } = await import(
      '../../packages/server/src/modules/studio/repositories/users-store'
    )
    replaceUserProfiles(1, ['work', 'play'], 'work')

    expect(setProfileWorkspace(1, 'work', '/home/u/work')).toBe(true)
    expect(setProfileWorkspace(1, 'play', '/home/u/play')).toBe(true)

    expect(getProfileWorkspace(1, 'work')).toBe('/home/u/work')
    expect(getProfileWorkspace(1, 'play')).toBe('/home/u/play')
  })

  it('clears the default and refuses a profile the user cannot reach', async () => {
    const { setProfileWorkspace, getProfileWorkspace, replaceUserProfiles } = await import(
      '../../packages/server/src/modules/studio/repositories/users-store'
    )
    replaceUserProfiles(1, ['work'], 'work')
    setProfileWorkspace(1, 'work', '/home/u/work')

    expect(getProfileWorkspace(1, 'work')).toBe('/home/u/work')
    setProfileWorkspace(1, 'work', null)
    expect(getProfileWorkspace(1, 'work')).toBe('')

    expect(setProfileWorkspace(1, 'not-mine', '/tmp')).toBe(false)
    expect(setProfileWorkspace(2, 'work', '/tmp')).toBe(false)
  })
})
