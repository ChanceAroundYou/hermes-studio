import type { HermesProfile } from '@/api/hermes/profiles'

type ProfileNameSource = Pick<HermesProfile, 'name' | 'alias' | 'displayName'>

/**
 * Resolve the name to show for a profile.
 *
 * Order of preference:
 *   1. the custom display name set in the Web UI (e.g. "小鸡毛"),
 *   2. the upstream `alias` reported by the Hermes CLI profile list,
 *   3. the real profile name.
 *
 * The profile name stays the identifier used for every API call; only the label
 * changes. Keeping `alias` in the chain preserves upstream behaviour for
 * profiles that never set a custom name.
 *
 * Deliberately a pure function taking the profile list rather than a profiles-
 * store method: ~19 client tests mock `@/stores/hermes/profiles` with a minimal
 * object (`{ profiles: [] }`), so anything hung off the store would break them
 * at render time. Callers pass `profilesStore.profiles`, which keeps reactivity
 * in a `computed` while a minimal mock degrades gracefully to the fallback.
 */
export function resolveProfileDisplayName(
  profiles: ProfileNameSource[] | null | undefined,
  name: string | null | undefined,
): string {
  const resolved = (name || '').trim()
  if (!resolved) return ''
  const profile = profiles?.find(item => item.name === resolved)
  const custom = (profile?.displayName || '').trim()
  if (custom) return custom
  const alias = (profile?.alias || '').trim()
  if (alias) return alias
  return resolved
}

/** Whether the profile has a custom display name configured. */
export function hasCustomProfileDisplayName(
  profiles: ProfileNameSource[] | null | undefined,
  name: string | null | undefined,
): boolean {
  const resolved = (name || '').trim()
  if (!resolved) return false
  const profile = profiles?.find(item => item.name === resolved)
  return Boolean((profile?.displayName || '').trim())
}
