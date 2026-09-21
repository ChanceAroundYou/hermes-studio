import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getWebUiHome } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'

/**
 * Per-profile custom display name (e.g. "小鸡毛").
 *
 * Stored beside the avatar metadata under the Web UI home, so it follows a
 * profile rename (the whole metadata directory is renamed) and never leaks into
 * Hermes Agent state. Readers fall back to the raw profile name when nothing is
 * configured, so callers can use `profileDisplayName()` unconditionally.
 */

export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 32

interface ProfileDisplayNameMeta {
  displayName: string
  updatedAt: number
}

interface CachedProfileDisplayName {
  signature: string
  displayName: string | null
}

const displayNameCache = new Map<string, CachedProfileDisplayName>()

export function profileMetadataDir(name: string): string {
  const segment = Buffer.from(name || 'default', 'utf-8').toString('base64url')
  return join(getWebUiHome(), 'profile-metadata', segment)
}

export function profileDisplayNamePath(name: string): string {
  return join(profileMetadataDir(name), 'display-name.json')
}

/** Clear the read cache for a profile (call after rename/delete). */
export function invalidateProfileDisplayNameCache(name: string): void {
  displayNameCache.delete(name)
}

/**
 * Normalize user input. Returns null when the value clears the custom name
 * (empty/whitespace), so the UI falls back to the profile name.
 */
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Strip control characters but keep printable unicode (CJK, emoji, …).
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!cleaned) return null
  return Array.from(cleaned).slice(0, PROFILE_DISPLAY_NAME_MAX_LENGTH).join('')
}

/** The configured custom name, or null when none is set. */
export function readProfileDisplayName(name: string): string | null {
  const filePath = profileDisplayNamePath(name)
  if (!existsSync(filePath)) {
    displayNameCache.delete(name)
    return null
  }
  try {
    const stat = statSync(filePath)
    const signature = `${stat.mtimeMs}:${stat.size}`
    const cached = displayNameCache.get(name)
    if (cached?.signature === signature) return cached.displayName

    const meta = JSON.parse(readFileSync(filePath, 'utf-8')) as ProfileDisplayNameMeta
    const displayName = normalizeDisplayName(meta?.displayName)
    displayNameCache.set(name, { signature, displayName })
    return displayName
  } catch (err) {
    logger.warn(err, '[profiles] failed to read display name for profile "%s"', name)
    return null
  }
}

/** The name to show in the UI: custom name when set, otherwise the profile name. */
export function profileDisplayName(name: string): string {
  return readProfileDisplayName(name) ?? name
}

/**
 * Persist (or clear) the custom display name. Null/empty removes the file so
 * the profile falls back to its real name.
 */
export function writeProfileDisplayName(name: string, value: unknown): string | null {
  const displayName = normalizeDisplayName(value)
  const filePath = profileDisplayNamePath(name)
  displayNameCache.delete(name)
  if (!displayName) {
    rmSync(filePath, { force: true })
    removeProfileMetadataDirIfEmpty(name)
    return null
  }
  mkdirSync(profileMetadataDir(name), { recursive: true })
  const meta: ProfileDisplayNameMeta = { displayName, updatedAt: Date.now() }
  writeFileSync(filePath, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
  return displayName
}

/**
 * Remove ONLY the avatar files, preserving a configured display name.
 *
 * `deleteAvatar` previously dropped the whole metadata directory, which would
 * silently discard the custom name set alongside it.
 */
export function removeProfileAvatarFiles(name: string): void {
  rmSync(join(profileMetadataDir(name), 'avatar.json'), { force: true })
  rmSync(join(profileMetadataDir(name), 'avatar.bin'), { force: true })
  removeProfileMetadataDirIfEmpty(name)
}

export function forgetProfileDisplayName(name: string): void {
  displayNameCache.delete(name)
  rmSync(profileDisplayNamePath(name), { force: true })
}

function removeProfileMetadataDirIfEmpty(name: string): void {
  const dir = profileMetadataDir(name)
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    /* non-fatal: an empty leftover directory is harmless */
  }
}
