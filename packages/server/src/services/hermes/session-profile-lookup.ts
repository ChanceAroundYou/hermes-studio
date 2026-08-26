import { listProfileNamesFromDisk } from './hermes-profile'

export async function findSessionAcrossProfiles(sessionId: string): Promise<{ profile: string; row: unknown } | null> {
  const { getExactSessionDetailFromDbWithProfile } = await import('../../db/hermes/sessions-db')
  for (const profile of listProfileNamesFromDisk()) {
    try {
      const row = await getExactSessionDetailFromDbWithProfile(sessionId, profile)
      if (row) return { profile, row }
    } catch { /* DB missing / unreadable */ }
  }
  return null
}

export async function findSessionProfile(sessionId: string): Promise<string | null> {
  const r = await findSessionAcrossProfiles(sessionId)
  return r?.profile || null
}
