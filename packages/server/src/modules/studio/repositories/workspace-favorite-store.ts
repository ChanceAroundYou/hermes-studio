import { getDb } from '../infrastructure/database'
import { WORKSPACE_FAVORITES_TABLE } from '../infrastructure/database/schemas'

/** Guard rails so a bad client cannot grow the table without bound. */
export const WORKSPACE_FAVORITE_PATH_MAX_LENGTH = 1024
export const WORKSPACE_FAVORITE_MAX_PER_USER = 200

export interface WorkspaceFavoriteRecord {
  path: string
  createdAt: number
}

/**
 * Workspace favourites are stored per authenticated user, so the list follows
 * the account across browsers and devices instead of living in one browser's
 * localStorage. Ordering is oldest-first so the row of favourites in the picker
 * keeps a stable, user-controlled order.
 */
export function normalizeWorkspaceFavoritePath(value: unknown): string {
  if (typeof value !== 'string') return ''
  // Trim trailing separators so `/a/b/` and `/a/b` are the same directory, but
  // keep a bare root such as `/` or `C:\` intact.
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z]:\\?$/.test(trimmed)) return trimmed
  const collapsed = trimmed.replace(/[/\\]+$/, '')
  return (collapsed || trimmed).slice(0, WORKSPACE_FAVORITE_PATH_MAX_LENGTH)
}

export function listWorkspaceFavorites(userId: number): WorkspaceFavoriteRecord[] {
  const db = getDb()
  if (!db || !Number.isInteger(userId) || userId <= 0) return []
  const rows = db.prepare(
    `SELECT path, created_at FROM ${WORKSPACE_FAVORITES_TABLE} WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(userId) as Array<{ path?: unknown; created_at?: unknown }>
  return rows
    .map(row => ({
      path: String(row.path ?? ''),
      createdAt: Number(row.created_at) || 0,
    }))
    .filter(row => row.path !== '')
}

export function isWorkspaceFavorite(userId: number, path: string): boolean {
  const db = getDb()
  const normalized = normalizeWorkspaceFavoritePath(path)
  if (!db || !normalized || !Number.isInteger(userId) || userId <= 0) return false
  const row = db.prepare(
    `SELECT 1 FROM ${WORKSPACE_FAVORITES_TABLE} WHERE user_id = ? AND path = ?`,
  ).get(userId, normalized)
  return !!row
}

/** Idempotent: favouriting an already-favourited directory is not an error. */
export function addWorkspaceFavorite(userId: number, path: string): WorkspaceFavoriteRecord {
  const normalized = normalizeWorkspaceFavoritePath(path)
  if (!normalized) throw new Error('Workspace path is required')
  const db = getDb()
  if (!db || !Number.isInteger(userId) || userId <= 0) {
    return { path: normalized, createdAt: Math.floor(Date.now() / 1000) }
  }
  if (isWorkspaceFavorite(userId, normalized)) {
    const existing = listWorkspaceFavorites(userId).find(row => row.path === normalized)
    return existing || { path: normalized, createdAt: Math.floor(Date.now() / 1000) }
  }
  if (listWorkspaceFavorites(userId).length >= WORKSPACE_FAVORITE_MAX_PER_USER) {
    throw new Error(`At most ${WORKSPACE_FAVORITE_MAX_PER_USER} workspaces can be favourited`)
  }
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO ${WORKSPACE_FAVORITES_TABLE} (user_id, path, created_at) VALUES (?, ?, ?)`,
  ).run(userId, normalized, now)
  return { path: normalized, createdAt: now }
}

export function removeWorkspaceFavorite(userId: number, path: string): boolean {
  const db = getDb()
  const normalized = normalizeWorkspaceFavoritePath(path)
  if (!db || !normalized || !Number.isInteger(userId) || userId <= 0) return false
  const result = db.prepare(
    `DELETE FROM ${WORKSPACE_FAVORITES_TABLE} WHERE user_id = ? AND path = ?`,
  ).run(userId, normalized)
  return result.changes > 0
}
