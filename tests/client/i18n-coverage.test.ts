// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import ar from '@/i18n/locales/ar'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import baseline from '../fixtures/i18n-missing-baseline.json'

/**
 * A ratchet on locale coverage: a locale may keep the keys recorded in
 * `tests/fixtures/i18n-missing-baseline.json`, but no key may go missing that is
 * not recorded there. Translating a batch and regenerating the baseline with
 *
 *   npx vite-node scripts/i18n-gap.ts --baseline tests/fixtures/i18n-missing-baseline.json
 *
 * moves the ratchet forward, so the recorded gap can only shrink.
 */
const locales: Record<string, unknown> = { en, ar, de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
const allowed = baseline as Record<string, string[]>
// Upstream's JEV checks iterate the canonical locale list and read the raw
// (unmerged) messages. This fork's ratchet only needs the merged set, so both
// names are aliased onto what it already has.
const supportedLocales = Object.keys(locales)
const rawMessages = locales as Record<string, Record<string, unknown>>

function flatten(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
  } else if (typeof value === 'string') {
    out.add(prefix)
  }
  return out
}

const english = flatten(en)
const present = new Map(Object.entries(locales).map(([locale, messages]) => [locale, flatten(messages)]))

// --- JEV localization coverage (ported from upstream #3159) ---
// Upstream's version of this file also covers task plans and the changelog, which
// this fork's ratchet does not import. The JEV case is self-contained, so it is
// brought over with just the helpers it needs.
function flattenLeafPaths(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenLeafPaths(child, prefix ? `${prefix}.${key}` : key, out)
    }
  } else if (typeof value === 'string') {
    out.set(prefix, value)
  }
  return out
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()
}

it('localizes all JEV messages and error codes without relying on English fallback', () => {
  const expected = flattenLeafPaths(en.jev)
  for (const locale of Object.keys(locales)) {
    const actual = flattenLeafPaths((locales as Record<string, Record<string, unknown>>)[locale].jev)
    expect([...actual.keys()].sort(), locale).toEqual([...expected.keys()].sort())
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: (locales as Record<string, Record<string, unknown>>)[locale] } })
    for (const [key, english] of expected) {
      const value = actual.get(key)!
      expect(value.trim(), `${locale}: jev.${key}`).not.toBe('')
      expect(interpolationNames(value), `${locale}: jev.${key}`).toEqual(interpolationNames(english))
      expect(() => i18n.global.t(`jev.${key}`, { model: 'jev-test', duration: '123' })).not.toThrow()
      if (locale !== 'en') expect(value, `${locale}: jev.${key} copies English`).not.toBe(english)
    }
  }
})

describe('i18n coverage', () => {
  it.each(Object.keys(locales))('%s only misses the recorded keys', locale => {
    const keys = present.get(locale) ?? new Set<string>()
    const missing = [...english].filter(key => !keys.has(key)).sort()
    const permitted = new Set(allowed[locale] ?? [])
    const unexpected = missing.filter(key => !permitted.has(key))
    expect(
      unexpected,
      `unrecorded missing keys in ${locale}: ${unexpected.slice(0, 8).join(', ')}`,
    ).toEqual([])
  })
it('does not expose locale-code placeholders in generated JEV copy', () => {
  const guardedKeys = ['groupMessageRoutingEnabled', 'groupRoutingDisabled', 'groupRoutingReady', 'groupMessageRoutingMinConfidence', 'groupMessageRoutingMinConfidenceHint', 'groupMessageRoutingTimeout', 'groupMessageRoutingTimeoutHint', 'workflowQualityEnabled', 'workflowQualityDisabled', 'workflowQualityReady', 'workflowQualityMinConfidence', 'workflowQualityMinConfidenceHint', 'workflowQualityTimeout', 'workflowQualityTimeoutHint']
  for (const locale of supportedLocales) {
    const actual = flattenLeafPaths(rawMessages[locale].jev)
    for (const key of guardedKeys) {
      const value = actual.get(key)!
      expect(value, `${locale}: jev.${key} starts with a locale-code placeholder`).not.toMatch(/^(?:zh(?:-TW)?|en|ja|ko|fr|es|de|pt|ru|ar)\s+/i)
    }
  }
})

const SKILLS_USAGE_LOCALIZED_KEYS = [
  'sidebar.skillsUsage',
  'skillsUsage.title',
  'skillsUsage.subtitle',
  'skillsUsage.refresh',
  'skillsUsage.periodSelector',
  'skillsUsage.periodLabel',
  'skillsUsage.summary',
  'skillsUsage.totalActions',
  'skillsUsage.loads',
  'skillsUsage.edits',
  'skillsUsage.distinctSkills',
  'skillsUsage.topSkills',
  'skillsUsage.dailyTrend',
  'skillsUsage.periodSummary',
  'skillsUsage.skill',
  'skillsUsage.share',
  'skillsUsage.lastUsed',
  'skillsUsage.noData',
  'skillsUsage.loadFailed',
  'skillsUsage.otherSkills',
]

  it('records no key that a locale has already translated', () => {
    const stale: string[] = []
    for (const [locale, keys] of Object.entries(allowed)) {
      const translated = present.get(locale) ?? new Set<string>()
      for (const key of keys) {
        if (translated.has(key)) stale.push(`${locale}: ${key}`)
      }
    }
    expect(
      stale,
      `regenerate the baseline; these are translated now: ${stale.slice(0, 8).join(', ')}`,
    ).toEqual([])
  })
})
