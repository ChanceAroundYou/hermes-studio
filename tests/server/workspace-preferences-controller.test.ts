import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Controller-level coverage for the workspace preferences API, against a real
 * SQLite database. The interesting cases are the ones a live check is awkward
 * to reach: a profile the caller does not own must be refused rather than
 * silently written, and the two features must stay independent.
 */
function makeCtx(options: { userId?: number; body?: unknown; query?: Record<string, string> } = {}) {
  const ctx: any = {
    state: options.userId ? { user: { id: options.userId, username: 'tester' } } : {},
    request: { body: options.body },
    query: options.query || {},
    status: 200,
    body: undefined,
  }
  return ctx
}

describe('workspace preferences controller', () => {
  let db: any = null
  let ctrl: typeof import('../../packages/server/src/modules/studio/controllers/workspace-preferences')

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
    const { replaceUserProfiles } = await import('../../packages/server/src/modules/studio/repositories/users-store')
    // user 1 owns nothing; user 2 owns the two profiles.
    replaceUserProfiles(1, ['orphan'], 'orphan')
    replaceUserProfiles(2, ['work', 'play'], 'work')

    ctrl = await import('../../packages/server/src/modules/studio/controllers/workspace-preferences')
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('sets and clears the default for a profile the caller owns', async () => {
    const ok = makeCtx({ userId: 2, body: { profile: 'work', path: '/home/u/work' } })
    await ctrl.setDefaultWorkspace(ok)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ profile: 'work', defaultWorkspace: '/home/u/work' })

    const listed = makeCtx({ userId: 2, query: { profile: 'work' } })
    await ctrl.listWorkspacePreferences(listed)
    expect(listed.body.defaultWorkspace).toBe('/home/u/work')

    const cleared = makeCtx({ userId: 2, body: { profile: 'work', path: '' } })
    await ctrl.setDefaultWorkspace(cleared)
    expect(cleared.body.defaultWorkspace).toBe('')
  })

  it('keeps each profile default independent', async () => {
    await ctrl.setDefaultWorkspace(makeCtx({ userId: 2, body: { profile: 'work', path: '/a' } }))
    await ctrl.setDefaultWorkspace(makeCtx({ userId: 2, body: { profile: 'play', path: '/b' } }))

    const work = makeCtx({ userId: 2, query: { profile: 'work' } })
    await ctrl.listWorkspacePreferences(work)
    const play = makeCtx({ userId: 2, query: { profile: 'play' } })
    await ctrl.listWorkspacePreferences(play)

    expect(work.body.defaultWorkspace).toBe('/a')
    expect(play.body.defaultWorkspace).toBe('/b')
  })

  it('refuses a profile the caller does not own, without writing anything', async () => {
    const denied = makeCtx({ userId: 1, body: { profile: 'work', path: '/tmp' } })
    await ctrl.setDefaultWorkspace(denied)
    expect(denied.status).toBe(404)

    // And the real owner's value is untouched.
    const owner = makeCtx({ userId: 2, query: { profile: 'work' } })
    await ctrl.listWorkspacePreferences(owner)
    expect(owner.body.defaultWorkspace).toBe('')
  })

  it('never lets setting a default touch the favourites list', async () => {
    await ctrl.addFavorite(makeCtx({ userId: 2, body: { path: '/srv/data' } }))
    await ctrl.setDefaultWorkspace(makeCtx({ userId: 2, body: { profile: 'work', path: '/srv/data' } }))

    const listed = makeCtx({ userId: 2, query: { profile: 'work' } })
    await ctrl.listWorkspacePreferences(listed)
    expect(listed.body.favorites).toEqual(['/srv/data'])
    expect(listed.body.defaultWorkspace).toBe('/srv/data')

    // Removing the favourite leaves the default alone.
    await ctrl.removeFavorite(makeCtx({ userId: 2, body: { path: '/srv/data' } }))
    const after = makeCtx({ userId: 2, query: { profile: 'work' } })
    await ctrl.listWorkspacePreferences(after)
    expect(after.body.favorites).toEqual([])
    expect(after.body.defaultWorkspace).toBe('/srv/data')
  })

  it('requires a path for favourite mutations and a profile for the default', async () => {
    const noPath = makeCtx({ userId: 2, body: { path: '  ' } })
    await ctrl.addFavorite(noPath)
    expect(noPath.status).toBe(400)

    const noProfile = makeCtx({ userId: 2, body: { path: '/a' } })
    await ctrl.setDefaultWorkspace(noProfile)
    expect(noProfile.status).toBe(400)
  })

  it('reports unavailable rather than throwing when nobody is signed in', async () => {
    const anon = makeCtx({})
    await ctrl.listWorkspacePreferences(anon)
    expect(anon.status).toBe(503)

    const anonFav = makeCtx({ body: { path: '/a' } })
    await ctrl.addFavorite(anonFav)
    expect(anonFav.status).toBe(503)
  })

  it('treats removing something absent as already gone', async () => {
    const res = makeCtx({ userId: 2, body: { path: '/never/favourited' } })
    await ctrl.removeFavorite(res)
    expect(res.status).toBe(200)
    expect(res.body.favorites).toEqual([])
  })
})
