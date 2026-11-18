import { describe, expect, it } from 'vitest'
import { hasCustomProfileDisplayName, resolveProfileDisplayName } from '@/utils/hermes/profile-display-name'

const profiles = [
  { name: 'default', displayName: '小鸡毛' },
  { name: 'bianchengmao', displayName: '编程猫' },
  { name: 'plain', displayName: '' },
  { name: 'unset' },
  // Both kinds of name at once. Without this row the two steps of the chain are
  // never tested against each other and swapping their order still passes.
  { name: 'both', displayName: '小鸡毛的备用', alias: 'both-alias' },
  { name: 'blank-display', displayName: '   ', alias: 'blank-display-alias' },
]

describe('resolveProfileDisplayName', () => {
  it('prefers the custom display name', () => {
    expect(resolveProfileDisplayName(profiles, 'default')).toBe('小鸡毛')
    expect(resolveProfileDisplayName(profiles, 'bianchengmao')).toBe('编程猫')
  })

  it('puts the custom display name above the upstream alias', () => {
    // A profile renamed in the Web UI while the CLI also reports an alias: the name the
    // user chose wins, and the alias only fills the gap when no custom name exists.
    expect(resolveProfileDisplayName(profiles, 'both')).toBe('小鸡毛的备用')
    // A blank display name is treated as no display name, so the alias is used rather
    // than rendering whitespace.
    expect(resolveProfileDisplayName(profiles, 'blank-display')).toBe('blank-display-alias')
    expect(hasCustomProfileDisplayName(profiles, 'both')).toBe(true)
    expect(hasCustomProfileDisplayName(profiles, 'blank-display')).toBe(false)
  })

  it('falls back to the profile name when unset or blank', () => {
    expect(resolveProfileDisplayName(profiles, 'plain')).toBe('plain')
    expect(resolveProfileDisplayName(profiles, 'unset')).toBe('unset')
    expect(resolveProfileDisplayName(profiles, 'unknown')).toBe('unknown')
  })

  it('degrades gracefully when the profiles list is unavailable', () => {
    // The store is mocked with a minimal object in many client tests.
    expect(resolveProfileDisplayName(undefined, 'default')).toBe('default')
    expect(resolveProfileDisplayName(null, 'default')).toBe('default')
    expect(resolveProfileDisplayName([], 'default')).toBe('default')
  })

  it('returns an empty string for a missing profile name', () => {
    expect(resolveProfileDisplayName(profiles, '')).toBe('')
    expect(resolveProfileDisplayName(profiles, null)).toBe('')
    expect(resolveProfileDisplayName(profiles, undefined)).toBe('')
  })

  it('trims whitespace before matching and displaying', () => {
    expect(resolveProfileDisplayName(profiles, '  default  ')).toBe('小鸡毛')
    expect(resolveProfileDisplayName([{ name: 'a', displayName: '   ' }], 'a')).toBe('a')
  })
})

describe('hasCustomProfileDisplayName', () => {
  it('reports whether a custom name is configured', () => {
    expect(hasCustomProfileDisplayName(profiles, 'default')).toBe(true)
    expect(hasCustomProfileDisplayName(profiles, 'plain')).toBe(false)
    expect(hasCustomProfileDisplayName(profiles, 'unset')).toBe(false)
    expect(hasCustomProfileDisplayName(profiles, 'unknown')).toBe(false)
    expect(hasCustomProfileDisplayName(undefined, 'default')).toBe(false)
    expect(hasCustomProfileDisplayName(profiles, '')).toBe(false)
  })
})
