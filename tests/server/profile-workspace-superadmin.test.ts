import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A super admin is deliberately NOT profile-scoped: `updateManagedUser`
 * hard-codes an empty allowlist for them, so they never get a `user_profiles`
 * row. Every other profile gate in the server short-circuits accordingly:
 *
 *   user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
 *
 * (middleware/auth.ts, chat-run.ts, global-agent.ts, kanban-events.ts,
 * workflow/schedule.ts). The per-profile workspace originally used the bare
 * `userCanAccessProfile`, so on the account that actually runs this install the
 * ownership check was always false: setting a default 404'd and the UI rolled
 * its optimistic update back — "it flashes then reverts".
 */
describe('per-profile default workspace and the super admin bypass', () => {
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
    return import('../../packages/server/src/modules/studio/repositories/users-store')
  }

  /** user 1 = super admin with an EMPTY allowlist, user 2 = admin with profiles. */
  async function seed() {
    const { createUser, replaceUserProfiles } = await store()
    createUser({ username: 'owner', password: 'secret1', role: 'super_admin' })
    createUser({ username: 'tenant', password: 'secret2', role: 'admin' })
    replaceUserProfiles(2, ['default', 'work'], 'default')
  }

  it('lets a super admin set a default even with an empty profile allowlist', async () => {
    await seed()
    const { setProfileWorkspace, getProfileWorkspace, listUserProfiles } = await store()

    // This is the exact state that broke the UI: no allowlist rows at all.
    expect(listUserProfiles(1)).toEqual([])

    expect(setProfileWorkspace(1, 'work', '/home/u/work')).toBe(true)
    expect(getProfileWorkspace(1, 'work')).toBe('/home/u/work')
  })

  it('keeps super admin and regular user defaults independent', async () => {
    await seed()
    const { setProfileWorkspace, getProfileWorkspace } = await store()

    setProfileWorkspace(1, 'work', '/home/owner/work')
    setProfileWorkspace(2, 'work', '/home/tenant/work')

    expect(getProfileWorkspace(1, 'work')).toBe('/home/owner/work')
    expect(getProfileWorkspace(2, 'work')).toBe('/home/tenant/work')
  })

  it('still refuses a profile the regular user is not allowed', async () => {
    await seed()
    const { setProfileWorkspace, getProfileWorkspace } = await store()

    expect(setProfileWorkspace(2, 'secret', '/home/tenant/secret')).toBe(false)
    expect(getProfileWorkspace(2, 'secret')).toBe('')
  })

  it('refuses an unknown account', async () => {
    await seed()
    const { setProfileWorkspace } = await store()
    expect(setProfileWorkspace(999, 'work', '/tmp')).toBe(false)
  })

  it('clears a default and round-trips empty', async () => {
    await seed()
    const { setProfileWorkspace, getProfileWorkspace } = await store()

    setProfileWorkspace(1, 'work', '/home/u/work')
    setProfileWorkspace(1, 'work', null)
    expect(getProfileWorkspace(1, 'work')).toBe('')

    setProfileWorkspace(1, 'work', '   ')
    expect(getProfileWorkspace(1, 'work')).toBe('')
  })

  it('does not lose the default when the account is saved again', async () => {
    // `updateManagedUser` sends an empty profile list for a super admin, so a
    // routine account edit used to wipe the stored default.
    await seed()
    const { setProfileWorkspace, getProfileWorkspace, replaceUserProfiles } = await store()

    setProfileWorkspace(1, 'work', '/home/u/work')
    replaceUserProfiles(1, [], null)

    expect(getProfileWorkspace(1, 'work')).toBe('/home/u/work')
  })

  it('carries the default across an allowlist edit that keeps the profile', async () => {
    await seed()
    const { setProfileWorkspace, getProfileWorkspace, replaceUserProfiles } = await store()

    setProfileWorkspace(2, 'work', '/home/tenant/work')
    replaceUserProfiles(2, ['default', 'work', 'extra'], 'default')

    expect(getProfileWorkspace(2, 'work')).toBe('/home/tenant/work')
    // ...and a profile removed from the allowlist really loses access.
    replaceUserProfiles(2, ['default'], 'default')
    expect(setProfileWorkspace(2, 'work', '/home/tenant/work')).toBe(false)
  })
})
