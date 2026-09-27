import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { getDb } from '../infrastructure/database'
import { USER_PROFILE_WORKSPACES_TABLE, USER_PROFILES_TABLE, USER_THEMES_TABLE, USERS_TABLE } from '../infrastructure/database/schemas'

export type UserRole = 'super_admin' | 'admin'
export type UserStatus = 'active' | 'disabled'
export type UserId = number | string

export interface UserRecord {
  id: number
  username: string
  password_hash: string
  role: UserRole
  status: UserStatus
  created_at: number
  updated_at: number
  last_login_at: number | null
  avatar: string
}

export interface UserProfileRecord {
  user_id: number
  profile_name: string
  is_default: number
  created_at: number
}

export interface UserSummary {
  id: number
  username: string
  role: UserRole
  status: UserStatus
  profiles: string[]
  default_profile: string | null
  created_at: number
  updated_at: number
  last_login_at: number | null
}

export const DEFAULT_USERNAME = 'admin'
export const DEFAULT_PASSWORD = '123456'
export const DEFAULT_PROFILE_NAME = 'default'

const SCRYPT_KEY_LEN = 64

function normalizeUserId(id: UserId): number | null {
  const userId = typeof id === 'number' ? id : Number(id)
  return Number.isInteger(userId) && userId > 0 ? userId : null
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [scheme, salt, expectedHex] = passwordHash.split(':')
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false
  try {
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = scryptSync(password, salt, expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function findUserById(id: UserId): UserRecord | null {
  const db = getDb()
  if (!db) return null
  const userId = normalizeUserId(id)
  if (!userId) return null
  const row = db.prepare(`SELECT * FROM ${USERS_TABLE} WHERE id = ?`).get(userId) as UserRecord | undefined
  return row || null
}

export function findUserByUsername(username: string): UserRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${USERS_TABLE} WHERE username = ?`).get(username) as UserRecord | undefined
  return row || null
}

export function findFirstUser(): UserRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${USERS_TABLE} ORDER BY id ASC LIMIT 1`).get() as UserRecord | undefined
  return row || null
}

export function listUsers(): UserSummary[] {
  const db = getDb()
  if (!db) return []
  const users = db.prepare(
    `SELECT id, username, role, status, created_at, updated_at, last_login_at FROM ${USERS_TABLE} ORDER BY id ASC`
  ).all() as Array<Omit<UserSummary, 'profiles' | 'default_profile'>>
  return users.map(user => {
    const profiles = listUserProfiles(user.id)
    return {
      ...user,
      profiles: profiles.map(profile => profile.profile_name),
      default_profile: profiles.find(profile => profile.is_default === 1)?.profile_name || null,
    }
  })
}

export function listUserProfiles(userId: UserId): UserProfileRecord[] {
  const db = getDb()
  if (!db) return []
  const id = normalizeUserId(userId)
  if (!id) return []
  return db.prepare(
    `SELECT * FROM ${USER_PROFILES_TABLE} WHERE user_id = ? ORDER BY is_default DESC, profile_name ASC`
  ).all(id) as unknown as UserProfileRecord[]
}

export function userCanAccessProfile(userId: UserId, profileName: string): boolean {
  const db = getDb()
  if (!db) return false
  const id = normalizeUserId(userId)
  if (!id) return false
  const row = db.prepare(
    `SELECT 1 FROM ${USER_PROFILES_TABLE} WHERE user_id = ? AND profile_name = ?`
  ).get(id, profileName)
  return !!row
}

/**
 * Whether `userId` may use `profileName`, using the same rule as every other
 * profile gate in the server (`middleware/auth.ts`, `chat-run.ts`,
 * `global-agent.ts`, `kanban-events.ts`, `workflow/schedule.ts`): a super admin
 * is deliberately NOT profile-scoped — `updateManagedUser` hard-codes an empty
 * allowlist for them — while everyone else needs the profile in their list.
 *
 * Without the bypass here the per-profile workspace was unreachable for exactly
 * the accounts that use it, and every write failed the ownership check.
 */
function canUseProfile(userId: UserId, profileName: string): boolean {
  // Strictly additive: the allowlist stays the only authority for everyone
  // else, so a missing user record narrows rather than widens access. The
  // super-admin case is a bypass, not a gate — see the note above.
  if (findUserById(userId)?.role === 'super_admin') return true
  return userCanAccessProfile(userId, profileName)
}

export function getDefaultProfileForUser(userId: UserId): string {
  const db = getDb()
  if (!db) return DEFAULT_PROFILE_NAME
  const id = normalizeUserId(userId)
  if (!id) return DEFAULT_PROFILE_NAME
  const row = db.prepare(
    `SELECT profile_name FROM ${USER_PROFILES_TABLE} WHERE user_id = ? AND is_default = 1 LIMIT 1`
  ).get(id) as { profile_name?: string } | undefined
  return row?.profile_name || DEFAULT_PROFILE_NAME
}

/**
 * The single directory a profile works in by default. Kept on the profile row
 * (not in a global list) so two profiles can default to different directories,
 * and so the value travels with the account.
 */
export function getProfileWorkspace(userId: UserId, profileName: string): string {
  const db = getDb()
  if (!db) return ''
  const id = normalizeUserId(userId)
  if (!id) return ''
  const name = String(profileName || '').trim()
  if (!name || !canUseProfile(id, name)) return ''
  const row = db.prepare(
    `SELECT workspace FROM ${USER_PROFILE_WORKSPACES_TABLE} WHERE user_id = ? AND profile_name = ?`,
  ).get(id, name) as { workspace?: unknown } | undefined
  return row?.workspace == null ? '' : String(row.workspace)
}

export function setProfileWorkspace(userId: UserId, profileName: string, workspace: string | null): boolean {
  const db = getDb()
  const id = normalizeUserId(userId)
  const name = String(profileName || '').trim()
  if (!db || !id || !name) return false
  if (!canUseProfile(id, name)) return false
  const value = workspace == null || String(workspace).trim() === '' ? null : String(workspace).trim()
  // Upsert: the slot is created on first write, so it does not matter whether
  // the profile happens to have an allowlist row.
  db.prepare(
    `INSERT INTO ${USER_PROFILE_WORKSPACES_TABLE} (user_id, profile_name, workspace, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, profile_name) DO UPDATE SET workspace = excluded.workspace, updated_at = excluded.updated_at`,
  ).run(id, name, value, Date.now())
  return true
}

export function countUsers(): number {
  const db = getDb()
  if (!db) return 0
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${USERS_TABLE}`).get() as { count?: number } | undefined
  return Number(row?.count || 0)
}

export function countActiveSuperAdmins(excludeUserId?: UserId): number {
  const db = getDb()
  if (!db) return 0
  const exclude = excludeUserId == null ? null : normalizeUserId(excludeUserId)
  const row = exclude
    ? db.prepare(`SELECT COUNT(*) as count FROM ${USERS_TABLE} WHERE role = 'super_admin' AND status = 'active' AND id != ?`).get(exclude)
    : db.prepare(`SELECT COUNT(*) as count FROM ${USERS_TABLE} WHERE role = 'super_admin' AND status = 'active'`).get()
  return Number((row as { count?: number } | undefined)?.count || 0)
}

export function touchUserLogin(userId: UserId, at = Date.now()): void {
  const db = getDb()
  if (!db) return
  const id = normalizeUserId(userId)
  if (!id) return
  db.prepare(`UPDATE ${USERS_TABLE} SET last_login_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id)
}

export function updateUserPassword(userId: UserId, password: string): boolean {
  const db = getDb()
  if (!db) return false
  const id = normalizeUserId(userId)
  if (!id) return false
  const result = db.prepare(`UPDATE ${USERS_TABLE} SET password_hash = ?, updated_at = ? WHERE id = ?`)
    .run(hashPassword(password), Date.now(), id)
  return result.changes > 0
}

export function updateUsername(userId: UserId, username: string): boolean {
  const db = getDb()
  if (!db) return false
  const id = normalizeUserId(userId)
  if (!id) return false
  const result = db.prepare(`UPDATE ${USERS_TABLE} SET username = ?, updated_at = ? WHERE id = ?`)
    .run(username, Date.now(), id)
  return result.changes > 0
}

export function getUserAvatar(userId: UserId): string {
  const db = getDb()
  if (!db) return ''
  const id = normalizeUserId(userId)
  if (!id) return ''
  const row = db.prepare(`SELECT avatar FROM ${USERS_TABLE} WHERE id = ?`).get(id) as { avatar?: string } | undefined
  return row?.avatar || ''
}

export function setUserAvatar(userId: UserId, avatarJson: string): boolean {
  const db = getDb()
  if (!db) return false
  const id = normalizeUserId(userId)
  if (!id) return false
  const result = db.prepare(`UPDATE ${USERS_TABLE} SET avatar = ?, updated_at = ? WHERE id = ?`)
    .run(avatarJson ?? '', Date.now(), id)
  return result.changes > 0
}

export function createUser(input: {
  username: string
  password: string
  role?: UserRole
  status?: UserStatus
  profiles?: string[]
  defaultProfile?: string | null
}): UserRecord | null {
  const db = getDb()
  if (!db) return null
  const now = Date.now()
  const role = input.role || 'admin'
  const status = input.status || 'active'
  db.prepare(
    `INSERT INTO ${USERS_TABLE} (username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(input.username, hashPassword(input.password), role, status, now, now)

  const user = findUserByUsername(input.username)
  if (user) replaceUserProfiles(user.id, input.profiles || [], input.defaultProfile)
  return user
}

export function updateUser(input: {
  userId: UserId
  username?: string
  role?: UserRole
  status?: UserStatus
  password?: string
  profiles?: string[]
  defaultProfile?: string | null
}): UserRecord | null {
  const db = getDb()
  if (!db) return null
  const id = normalizeUserId(input.userId)
  if (!id) return null

  const current = findUserById(id)
  if (!current) return null

  const nextUsername = input.username ?? current.username
  const nextRole = input.role ?? current.role
  const nextStatus = input.status ?? current.status
  const nextPasswordHash = input.password ? hashPassword(input.password) : current.password_hash
  const now = Date.now()

  db.prepare(
    `UPDATE ${USERS_TABLE}
     SET username = ?, password_hash = ?, role = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(nextUsername, nextPasswordHash, nextRole, nextStatus, now, id)

  if (input.profiles) replaceUserProfiles(id, input.profiles, input.defaultProfile)
  return findUserById(id)
}

export function deleteUser(userId: UserId): boolean {
  const db = getDb()
  if (!db) return false
  const id = normalizeUserId(userId)
  if (!id) return false
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${USER_PROFILES_TABLE} WHERE user_id = ?`).run(id)
    db.prepare(`DELETE FROM ${USER_PROFILE_WORKSPACES_TABLE} WHERE user_id = ?`).run(id)
    db.prepare(`DELETE FROM ${USER_THEMES_TABLE} WHERE user_id = ?`).run(id)
    const result = db.prepare(`DELETE FROM ${USERS_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
    return result.changes > 0
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function replaceUserProfiles(userId: UserId, profiles: string[], defaultProfile?: string | null): void {
  const db = getDb()
  if (!db) return
  const id = normalizeUserId(userId)
  if (!id) return

  const uniqueProfiles = [...new Set(profiles.map(profile => profile.trim()).filter(Boolean))]
  const defaultName = defaultProfile && uniqueProfiles.includes(defaultProfile) ? defaultProfile : uniqueProfiles[0] || null
  const now = Date.now()

  db.exec('BEGIN')
  try {
    // Only the allowlist is rewritten here. The per-profile defaults live in
    // their own table precisely so saving an account cannot discard them.
    db.prepare(`DELETE FROM ${USER_PROFILES_TABLE} WHERE user_id = ?`).run(id)
    const stmt = db.prepare(
      `INSERT INTO ${USER_PROFILES_TABLE} (user_id, profile_name, is_default, created_at) VALUES (?, ?, ?, ?)`
    )
    uniqueProfiles.forEach(profile => {
      stmt.run(id, profile, profile === defaultName ? 1 : 0, now)
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function createDefaultSuperAdmin(): UserRecord | null {
  const db = getDb()
  if (!db) return null

  const now = Date.now()
  db.prepare(
    `INSERT INTO ${USERS_TABLE} (username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(DEFAULT_USERNAME, hashPassword(DEFAULT_PASSWORD), 'super_admin', 'active', now, now)

  return findUserByUsername(DEFAULT_USERNAME)
}

export function bootstrapDefaultSuperAdmin(username: string, password: string): UserRecord | null {
  if (countUsers() > 0) return null
  if (username !== DEFAULT_USERNAME || password !== DEFAULT_PASSWORD) return null
  return createDefaultSuperAdmin()
}
