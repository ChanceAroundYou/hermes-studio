import { describe, expect, it, vi, beforeEach } from 'vitest'
import { workspaceFolderName } from '@/utils/hermes/workspace-path'

describe('workspaceFolderName', () => {
  it('returns the last segment', () => {
    expect(workspaceFolderName('/home/u/pics')).toBe('pics')
    expect(workspaceFolderName('C:\\Users\\me\\work')).toBe('work')
  })

  it('falls back to the whole path for roots and blanks', () => {
    expect(workspaceFolderName('/')).toBe('/')
    expect(workspaceFolderName('C:\\')).toBe('C:\\')
    expect(workspaceFolderName('')).toBe('')
    expect(workspaceFolderName(null)).toBe('')
  })
})

/** Each test gets its own mocked API module so the hoisted state never collides. */
function mockPreferencesApi(overrides: Record<string, unknown> = {}) {
  const api = {
    fetchWorkspacePreferences: vi.fn(async () => ({ favorites: [], defaultWorkspace: '', profile: 'p1' })),
    addWorkspaceFavorite: vi.fn(async (path: string) => [path]),
    removeWorkspaceFavorite: vi.fn(async () => [] as string[]),
    setProfileDefaultWorkspace: vi.fn(async () => ({ profile: 'p1', defaultWorkspace: '' })),
    ...overrides,
  }
  vi.doMock('@/api/studio/workspace-preferences', () => api)
  return api
}

async function loadPreferences() {
  const module = await import('@/composables/useWorkspacePreferences')
  return module.useWorkspacePreferences()
}

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('useWorkspacePreferences', () => {
  it('treats favourites and the per-profile default as independent server state', async () => {
    mockPreferencesApi({
      fetchWorkspacePreferences: vi.fn(async () => ({
        favorites: ['/srv/data'], defaultWorkspace: '/home/u', profile: 'p1',
      })),
      addWorkspaceFavorite: vi.fn(async () => ['/srv/data', '/home/u/work']),
      setProfileDefaultWorkspace: vi.fn(async () => ({ profile: 'p1', defaultWorkspace: '/home/u/work' })),
    })
    const prefs = await loadPreferences()
    await prefs.refresh('p1')

    expect(prefs.favorites.value).toEqual(['/srv/data'])
    expect(prefs.defaultWorkspaceFor('p1')).toBe('/home/u')

    // Favouriting must not move the profile default...
    await prefs.addFavorite('/home/u/work')
    expect(prefs.favorites.value).toEqual(['/srv/data', '/home/u/work'])
    expect(prefs.defaultWorkspaceFor('p1')).toBe('/home/u')

    // ...and setting the default must not touch the favourites list.
    await prefs.setDefaultWorkspace('p1', '/home/u/work')
    expect(prefs.defaultWorkspaceFor('p1')).toBe('/home/u/work')
    expect(prefs.favorites.value).toEqual(['/srv/data', '/home/u/work'])
  })

  it('shares one list across every caller, so a favourite added anywhere shows everywhere', async () => {
    mockPreferencesApi()
    const header = await loadPreferences()
    const picker = await loadPreferences()

    await header.addFavorite('/srv/data')
    expect(picker.favorites.value).toEqual(['/srv/data'])
    expect(picker.isFavorite('/srv/data')).toBe(true)
  })

  it('rolls the optimistic toggle back when the server rejects it', async () => {
    mockPreferencesApi({
      addWorkspaceFavorite: vi.fn(async () => { throw new Error('offline') }),
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const prefs = await loadPreferences()
    expect(await prefs.addFavorite('/srv/data')).toBe(false)
    expect(prefs.favorites.value).toEqual([])
  })

  it('normalises trailing separators so /a/b and /a/b/ are the same favourite', async () => {
    mockPreferencesApi({
      addWorkspaceFavorite: vi.fn(async () => ['/home/u/work']),
    })
    const prefs = await loadPreferences()
    await prefs.addFavorite('/home/u/work/')
    expect(prefs.isFavorite('/home/u/work')).toBe(true)
  })
})
