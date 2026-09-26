// @vitest-environment node
import { describe, expect, it } from 'vitest'
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
const locales: Record<string, unknown> = { ar, de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
const allowed = baseline as Record<string, string[]>

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
