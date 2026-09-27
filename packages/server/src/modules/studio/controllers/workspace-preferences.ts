import {
  addWorkspaceFavorite,
  listWorkspaceFavorites,
  normalizeWorkspaceFavoritePath,
  removeWorkspaceFavorite,
} from '../repositories/workspace-favorite-store'
import { getProfileWorkspace, setProfileWorkspace } from '../repositories/users-store'

/**
 * Workspace preferences: the user's shared favourites, and the one default
 * directory per profile. Both are account-scoped server state, so they are the
 * same in every browser and on every device — no localStorage.
 *
 * The two are independent on purpose: a profile has exactly one default, while
 * the favourites list is unlimited and shared by every profile of the account.
 */

function currentUserId(ctx: any): number {
  return Number(ctx.state?.user?.id || 0)
}

function requestedProfile(ctx: any): string {
  const fromQuery = ctx.query?.profile
  const fromBody = (ctx.request.body as { profile?: unknown } | undefined)?.profile
  const raw = typeof fromQuery === 'string' && fromQuery ? fromQuery : fromBody
  return typeof raw === 'string' ? raw.trim() : ''
}

function unavailable(ctx: any): void {
  ctx.status = 503
  ctx.body = { error: 'Workspace preferences are unavailable' }
}

export async function listWorkspacePreferences(ctx: any) {
  const userId = currentUserId(ctx)
  if (userId <= 0) return unavailable(ctx)
  const profile = requestedProfile(ctx)
  ctx.body = {
    favorites: listWorkspaceFavorites(userId).map(entry => entry.path),
    defaultWorkspace: profile ? getProfileWorkspace(userId, profile) : '',
    profile: profile || null,
  }
}

export async function addFavorite(ctx: any) {
  const userId = currentUserId(ctx)
  if (userId <= 0) return unavailable(ctx)
  const body = ctx.request.body as { path?: unknown }
  const path = normalizeWorkspaceFavoritePath(body?.path)
  if (!path) {
    ctx.status = 400
    ctx.body = { error: 'Workspace path is required' }
    return
  }
  try {
    addWorkspaceFavorite(userId, path)
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to add workspace' }
    return
  }
  ctx.body = { favorites: listWorkspaceFavorites(userId).map(entry => entry.path) }
}

export async function removeFavorite(ctx: any) {
  const userId = currentUserId(ctx)
  if (userId <= 0) return unavailable(ctx)
  const body = ctx.request.body as { path?: unknown }
  const path = normalizeWorkspaceFavoritePath(body?.path)
  if (!path) {
    ctx.status = 400
    ctx.body = { error: 'Workspace path is required' }
    return
  }
  removeWorkspaceFavorite(userId, path)
  // Removing something that is not there is not an error: the caller wanted it
  // gone, and it is gone.
  ctx.body = { favorites: listWorkspaceFavorites(userId).map(entry => entry.path) }
}

export async function setDefaultWorkspace(ctx: any) {
  const userId = currentUserId(ctx)
  if (userId <= 0) return unavailable(ctx)
  const body = (ctx.request.body || {}) as { profile?: unknown; path?: unknown }
  const profile = typeof body.profile === 'string' ? body.profile.trim() : ''
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required' }
    return
  }
  const raw = typeof body.path === 'string' ? body.path : ''
  const path = raw.trim() ? normalizeWorkspaceFavoritePath(raw) : null
  if (!setProfileWorkspace(userId, profile, path)) {
    ctx.status = 404
    ctx.body = { error: 'Profile not found' }
    return
  }
  ctx.body = { profile, defaultWorkspace: getProfileWorkspace(userId, profile) }
}
