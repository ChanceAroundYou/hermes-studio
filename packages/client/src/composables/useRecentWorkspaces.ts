import { ref } from 'vue'

const STORAGE_KEY_RECENT_WORKSPACES = 'hermes:recent_workspaces'
const MAX_RECENT_WORKSPACES = 10

export interface RecentWorkspaceEntry {
  path: string
  lastUsed: number
  useCount: number
}

/**
 * Recently used workspaces only.
 *
 * This used to also hold the "default workspaces" list in localStorage, which
 * is why favourites kept disagreeing between components. Defaults are now the
 * per-profile server setting and favourites are the shared server list, so the
 * only thing left here is device-local usage history, which genuinely belongs
 * to one machine.
 */
const recentWorkspaces = ref<RecentWorkspaceEntry[]>([])

function normalize(path: string | null | undefined): string {
  const trimmed = String(path || '').trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z]:\\?$/.test(trimmed)) return trimmed
  const collapsed = trimmed.replace(/[/\\]+$/, '')
  return collapsed || trimmed
}

function loadRecentWorkspaces(): RecentWorkspaceEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RECENT_WORKSPACES)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const entries = parsed.filter(
          (entry): entry is RecentWorkspaceEntry =>
            Boolean(entry) && typeof (entry as RecentWorkspaceEntry).path === 'string' && (entry as RecentWorkspaceEntry).path !== '',
        )
        recentWorkspaces.value = entries
        return entries
      }
    }
  } catch (e) {
    console.error('Failed to load recent workspaces:', e)
  }
  return recentWorkspaces.value
}

function saveRecentWorkspaces(workspaces: RecentWorkspaceEntry[]): void {
  recentWorkspaces.value = workspaces
  try {
    localStorage.setItem(STORAGE_KEY_RECENT_WORKSPACES, JSON.stringify(workspaces))
  } catch (e) {
    console.error('Failed to save recent workspaces:', e)
  }
}

function recordWorkspaceUsage(path: string): void {
  const target = normalize(path)
  if (!target) return
  const current = [...loadRecentWorkspaces()]
  const index = current.findIndex(entry => entry.path === target)
  if (index >= 0) {
    current[index] = { ...current[index], lastUsed: Date.now(), useCount: (current[index].useCount || 0) + 1 }
  } else {
    current.push({ path: target, lastUsed: Date.now(), useCount: 1 })
  }
  current.sort((a, b) => b.lastUsed - a.lastUsed)
  saveRecentWorkspaces(current.slice(0, MAX_RECENT_WORKSPACES))
}

function getSortedRecentWorkspaces(): RecentWorkspaceEntry[] {
  return [...recentWorkspaces.value].sort((a, b) => b.lastUsed - a.lastUsed)
}

function clearRecentWorkspaces(): void {
  saveRecentWorkspaces([])
}

export function useRecentWorkspaces() {
  if (recentWorkspaces.value.length === 0) loadRecentWorkspaces()
  return {
    recentWorkspaces,
    loadRecentWorkspaces,
    saveRecentWorkspaces,
    recordWorkspaceUsage,
    getSortedRecentWorkspaces,
    clearRecentWorkspaces,
  }
}
