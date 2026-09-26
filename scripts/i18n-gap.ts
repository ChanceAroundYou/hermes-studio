/**
 * Reports which keys `en.ts` has and a locale lacks, grouped by namespace, and
 * whether any source file actually asks for them.
 *
 *   npx vite-node scripts/i18n-gap.ts            # compact table
 *   npx vite-node scripts/i18n-gap.ts --json     # machine-readable report
 *
 * A missing key only matters when a call site asks for it: with
 * `fallbackLocale: 'en'` those read as English, and the rest read as nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import en from '../packages/client/src/i18n/locales/en'
import de from '../packages/client/src/i18n/locales/de'
import es from '../packages/client/src/i18n/locales/es'
import fr from '../packages/client/src/i18n/locales/fr'
import pt from '../packages/client/src/i18n/locales/pt'
import ja from '../packages/client/src/i18n/locales/ja'
import ko from '../packages/client/src/i18n/locales/ko'
import ru from '../packages/client/src/i18n/locales/ru'
import zhTW from '../packages/client/src/i18n/locales/zh-TW'
import zh from '../packages/client/src/i18n/locales/zh'
import ar from '../packages/client/src/i18n/locales/ar'

const localeModules: Record<string, Dict> = {
  de, es, fr, pt, ja, ko, ru, 'zh-TW': zhTW, zh, ar,
}

type Dict = Record<string, unknown>

function flatten(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Dict)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
  } else if (typeof value === 'string') {
    out.set(prefix, value)
  }
  return out
}

const repoRoot = path.resolve(import.meta.dirname, '..')
const clientSrc = path.join(repoRoot, 'packages/client/src')

/** Every `t('some.key')` style literal in the client source. */
function referencedKeys(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'i18n') walk(full)
        continue
      }
      if (!/\.(vue|ts)$/.test(entry.name)) continue
      for (const match of fs.readFileSync(full, 'utf8').matchAll(/\bt\(\s*['"`]([A-Za-z_][\w.]*)['"`]/g)) {
        found.add(match[1])
      }
    }
  }
  walk(clientSrc)
  return found
}

const english = flatten(en)
const referenced = referencedKeys()

interface Gap {
  namespace: string
  key: string
  english: string
  referenced: boolean
}

const report: Record<string, Gap[]> = {}

for (const locale of Object.keys(localeModules)) {
  const messages = flatten(localeModules[locale])
  const missing: Gap[] = []
  for (const [key, value] of english) {
    if (messages.has(key)) continue
    missing.push({
      namespace: key.includes('.') ? key.slice(0, key.indexOf('.')) : '(top level)',
      key,
      english: value,
      referenced: referenced.has(key),
    })
  }
  report[locale] = missing.sort((a, b) => a.key.localeCompare(b.key))
}

const baselineFlag = process.argv.indexOf('--baseline')
if (baselineFlag !== -1) {
  const target = process.argv[baselineFlag + 1]
  const payload: Record<string, string[]> = {}
  for (const [locale, gaps] of Object.entries(report)) {
    payload[locale] = gaps.map(gap => gap.key)
  }
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`)
  const total = Object.values(payload).reduce((sum, keys) => sum + keys.length, 0)
  console.log(`wrote ${target} (${total} missing keys still to translate)`)
  process.exit(0)
}

if (process.argv.includes('--json')) {
  const target = process.argv[process.argv.indexOf('--json') + 1]
  const payload = JSON.stringify(report, null, 2)
  if (target && target.endsWith('.json')) {
    fs.writeFileSync(target, payload)
    console.log(`wrote ${target}`)
  } else {
    console.log(payload)
  }
} else {
  for (const [locale, gaps] of Object.entries(report)) {
    const byNamespace = new Map<string, { total: number; used: number }>()
    for (const gap of gaps) {
      const entry = byNamespace.get(gap.namespace) ?? { total: 0, used: 0 }
      entry.total += 1
      if (gap.referenced) entry.used += 1
      byNamespace.set(gap.namespace, entry)
    }
    const used = gaps.filter(gap => gap.referenced).length
    console.log(`\n${locale}: ${gaps.length} missing (${used} referenced in source)`)
    for (const [namespace, entry] of [...byNamespace].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${namespace.padEnd(24)} ${String(entry.total).padStart(4)} (${entry.used} used)`)
    }
  }
}
