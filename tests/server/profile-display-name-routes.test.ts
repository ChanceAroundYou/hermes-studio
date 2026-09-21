import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
let webUiHome: string

function metadataDir(name: string): string {
  return join(webUiHome, 'profile-metadata', Buffer.from(name, 'utf-8').toString('base64url'))
}

/** Minimal Koa-ish context for controller calls. */
function makeCtx(params: Record<string, string> = {}, body?: unknown, state: unknown = {}) {
  return {
    params,
    request: { body },
    state,
    status: 200,
    body: undefined as any,
  }
}

beforeEach(() => {
  vi.resetModules()
  webUiHome = mkdtempSync(join(tmpdir(), 'hermes-web-ui-dn-routes-'))
  process.env.HERMES_WEB_UI_HOME = webUiHome
})

afterEach(() => {
  try {
    rmSync(webUiHome, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
})

describe('profile display-name route', () => {
  it('persists a custom name, exposes it on the profile list, and clears back to the profile name', async () => {
    vi.doMock(
      '../../packages/server/src/modules/hermes/services/runtime/cli',
      () => ({
        listProfiles: vi.fn().mockResolvedValue([
          { name: 'default', active: true, model: 'test-model', alias: '' },
          { name: 'work', active: false, model: 'test-model', alias: '' },
        ]),
        getProfile: vi.fn(),
        createProfile: vi.fn(),
        deleteProfile: vi.fn(),
        renameProfile: vi.fn(),
        exportProfile: vi.fn(),
        importProfile: vi.fn(),
        listProfileRuntimes: vi.fn().mockResolvedValue(new Map()),
      }),
    )
    vi.doMock('../../packages/server/src/modules/hermes/services/skills/injector', () => ({
      HermesSkillInjector: class {
        async injectMissingSkills() { return { targets: [] } }
      },
    }))

    const ctrl = await import('../../packages/server/src/modules/hermes/controllers/profiles')

    // 1. Set the custom name.
    const putCtx = makeCtx({ name: 'default' }, { displayName: '小鸡毛' })
    await ctrl.updateDisplayName(putCtx)
    expect(putCtx.status).toBe(200)
    expect(putCtx.body).toEqual({ displayName: '小鸡毛', custom: true })

    // 2. It is on disk.
    const metaPath = join(metadataDir('default'), 'display-name.json')
    expect(existsSync(metaPath)).toBe(true)
    expect(JSON.parse(readFileSync(metaPath, 'utf-8')).displayName).toBe('小鸡毛')

    // 3. The list endpoint surfaces it, and other profiles fall back to their name.
    const listCtx = makeCtx({}, undefined, { profile: { name: 'default' } })
    await ctrl.list(listCtx)
    const listed = listCtx.body.profiles as any[]
    const byName = Object.fromEntries(listed.map(p => [p.name, p.displayName]))
    expect(byName.default).toBe('小鸡毛')
    // Every listed profile carries the field; unset ones fall back to their name.
    expect(listed.every(p => typeof p.displayName === 'string' && p.displayName.length > 0)).toBe(true)

    // 4. Clearing returns to the profile name and removes the file.
    const clearCtx = makeCtx({ name: 'default' }, { displayName: null })
    await ctrl.updateDisplayName(clearCtx)
    expect(clearCtx.body).toEqual({ displayName: 'default', custom: false })
    expect(existsSync(metaPath)).toBe(false)

    const listCtx2 = makeCtx({}, undefined, { profile: { name: 'default' } })
    await ctrl.list(listCtx2)
    expect((listCtx2.body.profiles as any[]).find(p => p.name === 'default').displayName).toBe('default')
  })

  it('keeps the custom name when the avatar is reset', async () => {
    vi.doMock(
      '../../packages/server/src/modules/hermes/services/runtime/cli',
      () => ({
        listProfiles: vi.fn().mockResolvedValue([]),
        getProfile: vi.fn(),
        createProfile: vi.fn(),
        deleteProfile: vi.fn(),
        renameProfile: vi.fn(),
        exportProfile: vi.fn(),
        importProfile: vi.fn(),
        listProfileRuntimes: vi.fn().mockResolvedValue(new Map()),
      }),
    )
    vi.doMock('../../packages/server/src/modules/hermes/services/skills/injector', () => ({
      HermesSkillInjector: class {
        async injectMissingSkills() { return { targets: [] } }
      },
    }))

    const ctrl = await import('../../packages/server/src/modules/hermes/controllers/profiles')

    await ctrl.updateDisplayName(makeCtx({ name: 'default' }, { displayName: '小鸡毛' }))
    // Simulate a stored avatar alongside the name.
    const avatarCtx = makeCtx({ name: 'default' }, {
      type: 'generated',
      seed: 'seed-1',
    })
    await ctrl.updateAvatar(avatarCtx)
    expect(existsSync(join(metadataDir('default'), 'avatar.json'))).toBe(true)

    // Resetting the avatar must not discard the display name.
    const delCtx = makeCtx({ name: 'default' })
    await ctrl.deleteAvatar(delCtx)
    expect(delCtx.body).toEqual({ success: true })
    expect(existsSync(join(metadataDir('default'), 'avatar.json'))).toBe(false)
    expect(existsSync(join(metadataDir('default'), 'display-name.json'))).toBe(true)
  })
})
