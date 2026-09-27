import { computed, ref } from 'vue'
import {
  addWorkspaceFavorite as addFavoriteApi,
  fetchWorkspacePreferences,
  removeWorkspaceFavorite as removeFavoriteApi,
  setProfileDefaultWorkspace,
} from '@/api/studio/workspace-preferences'

/**
 * Workspace favourites and per-profile defaults, both backed by the server so
 * they follow the account across browsers and devices.
 *
 * Module-scoped on purpose: the chat header, the new-chat drawer and every
 * FolderPicker instance act on the same list, and an in-flight refresh must not
 * clobber a toggle that landed while it was running.
 */
const favorites = ref<string[]>([])
const defaultByProfile = ref<Record<string, string>>({})
const loaded = ref(false)
const loading = ref(false)
let inFlight: Promise<void> | null = null

function normalize(path: string | null | undefined): string {
  const trimmed = String(path || '').trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z]:\\?$/.test(trimmed)) return trimmed
  const collapsed = trimmed.replace(/[/\\]+$/, '')
  return collapsed || trimmed
}

/** Share the live list from one mutation into the next, so toggles feel instant. */
function applyFavorites(next: string[]) {
  favorites.value = next
  loaded.value = true
}

async function refresh(profile?: string | null): Promise<void> {
  if (inFlight) return inFlight
  loading.value = true
  inFlight = (async () => {
    try {
      const result = await fetchWorkspacePreferences(profile)
      favorites.value = result.favorites
      if (result.profile) {
        defaultByProfile.value = { ...defaultByProfile.value, [result.profile]: result.defaultWorkspace }
      }
      loaded.value = true
    } catch (err) {
      console.warn('Failed to load workspace preferences:', err)
    } finally {
      loading.value = false
      inFlight = null
    }
  })()
  return inFlight
}

async function addFavorite(path: string): Promise<boolean> {
  const target = normalize(path)
  if (!target) return false
  if (favorites.value.includes(target)) return true
  // Optimistic, then reconciled with the server's authoritative list.
  applyFavorites([...favorites.value, target])
  try {
    applyFavorites(await addFavoriteApi(target))
    return true
  } catch (err) {
    console.warn('Failed to favourite workspace:', err)
    await refresh()
    return false
  }
}

async function removeFavorite(path: string): Promise<boolean> {
  const target = normalize(path)
  if (!target) return false
  if (!favorites.value.includes(target)) return true
  applyFavorites(favorites.value.filter(entry => entry !== target))
  try {
    applyFavorites(await removeFavoriteApi(target))
    return true
  } catch (err) {
    console.warn('Failed to remove workspace favourite:', err)
    await refresh()
    return false
  }
}

async function toggleFavorite(path: string): Promise<boolean> {
  const target = normalize(path)
  if (!target) return false
  return favorites.value.includes(target) ? removeFavorite(target) : addFavorite(target)
}

/** The one directory a profile works in. Setting it never touches favourites. */
async function setDefaultWorkspace(profile: string, path: string | null): Promise<boolean> {
  const name = String(profile || '').trim()
  if (!name) return false
  const target = normalize(path)
  defaultByProfile.value = { ...defaultByProfile.value, [name]: target }
  try {
    const result = await setProfileDefaultWorkspace(name, target || null)
    defaultByProfile.value = { ...defaultByProfile.value, [name]: result.defaultWorkspace || '' }
    return true
  } catch (err) {
    console.warn('Failed to set the default workspace:', err)
    await refresh(name)
    return false
  }
}

function isFavorite(path: string | null | undefined): boolean {
  const target = normalize(path)
  return Boolean(target) && favorites.value.includes(target)
}

function defaultWorkspaceFor(profile: string | null | undefined): string {
  const name = String(profile || '').trim()
  return name ? (defaultByProfile.value[name] || '') : ''
}

export function useWorkspacePreferences() {
  return {
    favorites,
    defaultByProfile,
    loaded,
    loading,
    favoriteCount: computed(() => favorites.value.length),
    hasFavorites: computed(() => favorites.value.length > 0),
    refresh,
    addFavorite,
    removeFavorite,
    toggleFavorite,
    isFavorite,
    setDefaultWorkspace,
    defaultWorkspaceFor,
  }
}
