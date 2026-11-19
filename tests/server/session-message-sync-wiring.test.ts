import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The sweep has to actually start.
 *
 * `startSessionMessageSync` is useless if nothing calls it: the on-session-open
 * reconcile only covers sessions somebody opens, so a CLI turn, a Feishu reply or
 * a cron run would stay stale in the mirror forever -- silently, because nothing
 * errors. That is exactly how it was first merged: the service existed and was
 * tested, and the process never started it.
 */
const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')
const controller = readFileSync(
  'packages/server/src/modules/studio/controllers/sessions.ts',
  'utf8',
)

describe('the mirror reconcile is actually wired', () => {
  it('starts the periodic sweep at boot', () => {
    expect(bootstrap).toContain('startSessionMessageSync')
    // Called with a profile, not merely imported.
    expect(bootstrap).toMatch(/startSessionMessageSync\(\s*['"]/)
  })

  it('reconciles on session open as well', () => {
    // The two cover different sessions: boot covers the unattended ones, open
    // covers the one the user is about to look at.
    expect(controller).toContain('scheduleSessionSync')
  })
})
