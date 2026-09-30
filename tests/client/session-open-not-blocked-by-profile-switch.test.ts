import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * Opening a chat re-asserts the profile the session belongs to, and that call
 * used to sit in front of the message fetch. `PUT /api/hermes/profiles/active`
 * spawns the hermes CLI (`profile use`, ~0.8s measured) and re-scans the
 * profile's skill tree to inject bundled skills, so every session open paid a
 * guaranteed sub-second stall before a single message was requested -- and the
 * server-side queries that actually load the transcript take 3-5ms.
 *
 * The fix is two-sided: the endpoint short-circuits when the profile is already
 * active, and the client no longer serialises the message page behind the switch.
 * The resume still waits, because it travels on the profile-bound chat-run
 * socket.
 */
const readClient = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')
const readServer = (path: string) => readFileSync(`packages/server/src/${path}`, 'utf8')

describe('opening a session is not blocked by a redundant profile switch', () => {
  it('short-circuits the switch endpoint when the profile is already active', () => {
    const ctrl = readServer('modules/hermes/controllers/profiles.ts')
    const start = ctrl.indexOf('export async function switchProfile')
    expect(start).toBeGreaterThan(-1)
    const body = ctrl.slice(start, ctrl.indexOf('\nexport async function', start + 10))

    // The expensive work is the CLI spawn and the skill-tree rescan. Both must
    // sit behind the guard, not before it.
    const guard = body.indexOf('getActiveProfileName() === name')
    const cli = body.indexOf('useProfileWithFallback(name)')
    const inject = body.indexOf('injectBundledSkillsForProfile(name)')
    expect(guard).toBeGreaterThan(-1)
    expect(cli).toBeGreaterThan(guard)
    expect(inject).toBeGreaterThan(guard)
    // And the request is answered rather than falling through.
    expect(body.slice(guard, cli)).toContain('ctx.body')
  })

  it('loads the message page without waiting for the profile switch', () => {
    const store = readClient('stores/hermes/chat.ts')
    const start = store.indexOf('async function switchSession')
    expect(start).toBeGreaterThan(-1)
    const body = store.slice(start, store.indexOf('\nasync function', start + 20))

    // A cross-profile switch must be handed off as a promise, never awaited in
    // place: awaiting it here is what put the CLI spawn in front of the fetch.
    expect(body).toContain('let profileSwitch: Promise<unknown> | null = null')
    expect(body).toContain('profileSwitch = profilesStore.switchHermesProfile(targetProfile)')
    expect(body).not.toMatch(/await profilesStore\.switchHermesProfile\(targetProfile\)/)

    // Opening a session in the profile you are already in has nothing to wait
    // for, so that path stays synchronous and adds no microtask -- otherwise the
    // socket resume slips a tick later and callers that respond synchronously
    // (the rapid-switch tests) race it.
    const connectAt = body.indexOf('connectChatRun(targetProfile)')
    expect(connectAt).toBeGreaterThan(body.indexOf('profileSwitch = profilesStore.switchHermesProfile'))

    // The message page read is not sequenced behind the switch.
    const fetchAt = body.indexOf('await fetchSessionMessagesPage(sessionId, 0, limit, target.profile)')
    expect(fetchAt).toBeGreaterThan(connectAt)
    // The socket resume, which is profile-bound, still waits for a real switch.
    const awaitAt = body.indexOf('if (profileSwitch) await profileSwitch')
    expect(awaitAt).toBeGreaterThan(fetchAt)
    expect(body.indexOf('resumeSession(sessionId', awaitAt)).toBeGreaterThan(awaitAt)

    // The promise carries its own rejection handler, so awaiting it is safe.
    const switchAt = body.indexOf('profileSwitch = profilesStore.switchHermesProfile')
    expect(body.slice(switchAt, connectAt)).toContain('.catch(err =>')
  })
})
