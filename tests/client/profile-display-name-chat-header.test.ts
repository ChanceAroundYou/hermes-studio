import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The chat message header renders the profile name for every user message.
 * a440c83ac routed it through resolveProfileDisplayName so a custom display
 * name such as "\u5c0f\u9e21\u6bdb" shows up there; 1c8692c07 took the whole of
 * upstream #3232 and quietly restored the raw alias fallback, which is why a
 * new chat went back to saying "default".
 *
 * The resolver had its own tests and they all passed, because nothing covered
 * the wiring. This file is that missing guard: it asserts the chat header
 * actually calls the resolver rather than re-deriving the name itself.
 */
const source = readFileSync(
  'packages/client/src/components/hermes/chat/MessageList.vue',
  'utf8',
)

describe('chat message header profile name', () => {
  it('imports the shared display name resolver', () => {
    // Quote style varies across the codebase, so match the module path only.
    expect(source).toMatch(
      /import \{ resolveProfileDisplayName \} from ["']@\/utils\/hermes\/profile-display-name["']/,
    )
  })

  it('resolves the displayed name instead of falling back to the raw alias', () => {
    // Upstream 0.8.20 added `props.userLabel`, which PersonView sets to a fixed "You"
    // label for the person's own turns. That override has to stay in front: a person
    // surface is not showing a Hermes profile at all. What must not come back is the
    // pre-a440c83ac `alias?.trim() || activeSessionProfileName` chain, which silently
    // returned the raw profile id whenever a profile had a display name but no alias.
    // This branch's MessageList has no overridable `userLabel`: the header
    // always goes through the shared resolver.
    expect(source).toMatch(
      /const userProfileName = computed\(\(\) => \(\s*\n?\s*(?:\/\/[^\n]*\n\s*)*resolveProfileDisplayName\(\s*profilesStore\.profiles,\s*activeSessionProfileName\.value,?\s*\)/,
    )
    expect(source).not.toMatch(/activeSessionProfile\.value\?\.alias\?\.trim\(\) \|\|/)
  })

  it('still derives the avatar from the profile record itself', () => {
    expect(source).toContain('activeSessionProfile.value?.avatar')
  })
})
