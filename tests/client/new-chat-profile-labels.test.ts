// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveProfileDisplayName } from '@/utils/hermes/profile-display-name'

/**
 * The new-chat profile picker used to label options with the raw profile name,
 * so a profile renamed to "小鸡毛" still showed as "default". These tests pin
 * the resolution rule that every profile label must go through, and the fact
 * that the underlying value is always the real name.
 */
const profiles = [
  { name: 'default', displayName: '小鸡毛' },
  { name: 'bianchengmao', displayName: '编程猫' },
  { name: 'plain' },
  { name: 'aliased', alias: 'aliased-profile' },
]

function labelFor(name: string): string {
  // Mirrors the computed in ChatPanel: resolver first, raw name as the fallback.
  return resolveProfileDisplayName(profiles, name) || name
}

function optionsFor(names: string[]) {
  return names.map(name => ({ label: labelFor(name), value: name }))
}

describe('new-chat profile options', () => {
  it('shows the custom display name instead of the profile name', () => {
    expect(optionsFor(['default'])).toEqual([{ label: '小鸡毛', value: 'default' }])
    expect(optionsFor(['bianchengmao'])).toEqual([{ label: '编程猫', value: 'bianchengmao' }])
  })

  it('keeps the real profile name as the value, because every API call uses it', () => {
    // Selecting "小鸡毛" has to send "default" to the server, not the nickname.
    const option = optionsFor(['default'])[0]
    expect(option.value).toBe('default')
    expect(option.value).not.toBe(option.label)
  })

  it('falls back to the name when no custom display name is set', () => {
    expect(optionsFor(['plain'])).toEqual([{ label: 'plain', value: 'plain' }])
  })

  it('honours the upstream alias, which an inline displayName check would miss', () => {
    // A hand-rolled `displayName || name` renders "aliased"; the resolver keeps
    // upstream behaviour and shows the alias.
    expect(labelFor('aliased')).toBe('aliased-profile')
  })

  it('does not invent a name for a profile that is not in the list', () => {
    expect(labelFor('unknown')).toBe('unknown')
  })
})
