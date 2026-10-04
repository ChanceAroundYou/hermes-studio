import { request } from '../client'

/** Skill summary as reported by the Ekko agent's own skill registry. This is a
 *  different registry from Hermes `/api/hermes/skills`: Ekko serves builtin,
 *  local and external (shared) skills through `/api/ekko/skills`. */
export interface EkkoSkillInfo {
  name: string
  description: string
  category: string
  source: 'builtin' | 'local' | 'external'
  sourcePath?: string
  enabled: boolean
  managedByEkko: boolean
  builtIn: boolean
  /** Host-side discoverability. A skill without `metadata.keywords` is listed
   *  but never routed to the model, so it must not be offered in the menu. */
  validationStatus?: 'valid' | 'needs_metadata' | 'invalid'
  validationError?: string
}

export interface EkkoSkillListResponse {
  ok: boolean
  skills: EkkoSkillInfo[]
}

/** Only `valid` skills reach the model: they carry the `metadata.keywords` the
 *  host needs for deterministic discovery. Offering a `needs_metadata` or
 *  `invalid` skill would be a dead menu entry, which is exactly the failure
 *  mode this path exists to avoid. */
export function isDispatchableEkkoSkill(skill: EkkoSkillInfo): boolean {
  // A null row is possible in this payload and throws here, which would fail the
  // whole filter and take every skill down with it. One bad row costs one skill.
  if (!skill || typeof skill !== 'object') return false
  return skill.validationStatus === 'valid' && skill.enabled === true
}

export async function fetchEkkoSkills(profile: string): Promise<EkkoSkillInfo[]> {
  const res = await request<EkkoSkillListResponse>(`/api/ekko/skills?profile=${encodeURIComponent(profile)}`)
  const skills = Array.isArray(res?.skills) ? res.skills : []
  return skills.filter(isDispatchableEkkoSkill)
}
