import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
let webUiHome: string
let displayNameModule: typeof import('../../packages/server/src/modules/hermes/services/profiles/profile-display-name')

function metadataDir(name: string): string {
  return join(webUiHome, 'profile-metadata', Buffer.from(name, 'utf-8').toString('base64url'))
}

beforeEach(async () => {
  webUiHome = mkdtempSync(join(tmpdir(), 'hermes-web-ui-display-name-'))
  process.env.HERMES_WEB_UI_HOME = webUiHome
  // Fresh import per test so the module-level read cache starts empty.
  displayNameModule = await import(
    '../../packages/server/src/modules/hermes/services/profiles/profile-display-name'
  )
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

describe('profile display name', () => {
  it('falls back to the profile name when nothing is configured', () => {
    const { profileDisplayName, readProfileDisplayName } = displayNameModule
    expect(readProfileDisplayName('default')).toBeNull()
    expect(profileDisplayName('default')).toBe('default')
    expect(profileDisplayName('bianchengmao')).toBe('bianchengmao')
  })

  it('stores and reads a custom unicode name for a profile', () => {
    const { writeProfileDisplayName, readProfileDisplayName, profileDisplayName } = displayNameModule
    expect(writeProfileDisplayName('default', '小鸡毛')).toBe('小鸡毛')
    expect(readProfileDisplayName('default')).toBe('小鸡毛')
    expect(profileDisplayName('default')).toBe('小鸡毛')

    const metaPath = join(metadataDir('default'), 'display-name.json')
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(meta.displayName).toBe('小鸡毛')
    expect(typeof meta.updatedAt).toBe('number')
  })

  it('keeps display names isolated per profile', () => {
    const { writeProfileDisplayName, profileDisplayName } = displayNameModule
    writeProfileDisplayName('default', '小鸡毛')
    writeProfileDisplayName('bianchengmao', '编程猫')
    expect(profileDisplayName('default')).toBe('小鸡毛')
    expect(profileDisplayName('bianchengmao')).toBe('编程猫')
    expect(profileDisplayName('other')).toBe('other')
  })

  it('preserves emoji and clears on blank input', () => {
    const { writeProfileDisplayName, profileDisplayName } = displayNameModule
    expect(writeProfileDisplayName('default', '🐤 小鸡毛')).toBe('🐤 小鸡毛')
    expect(writeProfileDisplayName('default', '   ')).toBeNull()
    expect(profileDisplayName('default')).toBe('default')
    expect(existsSync(join(metadataDir('default'), 'display-name.json'))).toBe(false)
  })

  it('strips control characters and rejects non-strings', () => {
    const { normalizeDisplayName } = displayNameModule
    expect(normalizeDisplayName('a\u0000b\u001fc')).toBe('abc')
    expect(normalizeDisplayName('  小鸡毛  ')).toBe('小鸡毛')
    expect(normalizeDisplayName('')).toBeNull()
    expect(normalizeDisplayName(null)).toBeNull()
    expect(normalizeDisplayName(123)).toBeNull()
  })

  it('caps the length by code points and drops the empty metadata directory', () => {
    const { writeProfileDisplayName, normalizeDisplayName, PROFILE_DISPLAY_NAME_MAX_LENGTH } = displayNameModule
    const saved = writeProfileDisplayName('default', '鸡'.repeat(100))
    expect(saved).not.toBeNull()
    expect(Array.from(saved as string)).toHaveLength(PROFILE_DISPLAY_NAME_MAX_LENGTH)
    expect(Array.from(normalizeDisplayName('🐤'.repeat(100)) as string)).toHaveLength(PROFILE_DISPLAY_NAME_MAX_LENGTH)

    writeProfileDisplayName('default', null)
    expect(existsSync(metadataDir('default'))).toBe(false)
  })

  it('keeps the display name when avatar metadata is removed', () => {
    const { writeProfileDisplayName, profileDisplayName, removeProfileAvatarFiles } = displayNameModule
    writeProfileDisplayName('default', '小鸡毛')
    mkdirSync(metadataDir('default'), { recursive: true })
    writeFileSync(join(metadataDir('default'), 'avatar.json'), '{"type":"generated","seed":"s","updatedAt":1}')
    writeFileSync(join(metadataDir('default'), 'avatar.bin'), 'binary')

    // Resetting the avatar must not discard the display name stored alongside it.
    removeProfileAvatarFiles('default')

    expect(profileDisplayName('default')).toBe('小鸡毛')
    expect(existsSync(join(metadataDir('default'), 'avatar.json'))).toBe(false)
    expect(existsSync(join(metadataDir('default'), 'avatar.bin'))).toBe(false)
    expect(existsSync(join(metadataDir('default'), 'display-name.json'))).toBe(true)
  })

  it('forgets the cached name when the profile is renamed or deleted', () => {
    const { writeProfileDisplayName, profileDisplayName, forgetProfileDisplayName } = displayNameModule
    writeProfileDisplayName('oldname', '小鸡毛')
    expect(profileDisplayName('oldname')).toBe('小鸡毛')
    forgetProfileDisplayName('oldname')
    expect(profileDisplayName('oldname')).toBe('oldname')
  })
})
