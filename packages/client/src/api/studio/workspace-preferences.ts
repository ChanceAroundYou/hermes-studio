import { request } from '../client'

/**
 * Workspace preferences, both account-scoped and stored server-side so they are
 * identical in every browser and on every device.
 *
 * Two independent concepts, deliberately not merged:
 *  - favourites: a shared, ordered list of directories, used by every profile;
 *  - default: the single directory one profile works in, auto-applied when a
 *    new session is started for that profile.
 */
export interface WorkspacePreferences {
  favorites: string[]
  defaultWorkspace: string
  profile: string | null
}

export async function fetchWorkspacePreferences(profile?: string | null): Promise<WorkspacePreferences> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const response = await request<Partial<WorkspacePreferences>>(`/api/studio/workspace/preferences${query}`)
  return {
    favorites: Array.isArray(response?.favorites) ? response!.favorites.map(String).filter(Boolean) : [],
    defaultWorkspace: typeof response?.defaultWorkspace === 'string' ? response.defaultWorkspace : '',
    profile: typeof response?.profile === 'string' ? response.profile : null,
  }
}

/** Both mutations answer with the authoritative list, so callers never guess. */
export async function addWorkspaceFavorite(path: string): Promise<string[]> {
  const response = await request<{ favorites?: unknown }>('/api/studio/workspace/favorites', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  return Array.isArray(response?.favorites) ? response.favorites.map(String).filter(Boolean) : []
}

export async function removeWorkspaceFavorite(path: string): Promise<string[]> {
  const response = await request<{ favorites?: unknown }>('/api/studio/workspace/favorites', {
    method: 'DELETE',
    body: JSON.stringify({ path }),
  })
  return Array.isArray(response?.favorites) ? response.favorites.map(String).filter(Boolean) : []
}

/** `null`/'' clears the profile default. */
export async function setProfileDefaultWorkspace(
  profile: string,
  path: string | null,
): Promise<{ profile: string; defaultWorkspace: string }> {
  return request<{ profile: string; defaultWorkspace: string }>('/api/studio/workspace/default', {
    method: 'PUT',
    body: JSON.stringify({ profile, path: path ?? '' }),
  })
}
