import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A `<ComponentName>` that no one imports compiles without error and renders as
 * a literal `<componentname>` element.
 *
 * That is how the mobile chat session list went blank: upstream wrapped the
 * sidebar in `<PageSidebar>` (whose whole job is to teleport its slot into the
 * mobile drawer), the import was dropped while resolving that file's conflict,
 * and the `<aside>` was left rendering in place behind the drawer. On desktop
 * nothing looked wrong because the teleport is disabled on a wide viewport.
 *
 * `vue-tsc` and `vite build` both pass through it: the template compiles to
 * `resolveComponent('PageSidebar')`, which only *warns* in dev and silently
 * falls back to the raw tag in production. So the only guard that works is
 * checking the source itself.
 */

const SRC = 'packages/client/src'

/** Framework tags registered by the runtime or by a plugin, not by an import. */
const RUNTIME_TAGS = new Set([
  'Teleport',
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Suspense',
  'Component',
  'Slot',
  'RouterLink',
  'RouterView',
])

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

/** Tags used in the template block that the SFC neither imports nor defines. */
function unresolvedTags(source: string): string[] {
  const templateMatch = source.match(/<template>([\s\S]*)<\/template>/)
  if (!templateMatch) return []
  const template = templateMatch[1]!
  const script = source.slice(0, templateMatch.index) + source.slice(templateMatch.index + templateMatch[0].length)

  const used = new Set(Array.from(template.matchAll(/<([A-Z][A-Za-z0-9]*)/g), match => match[1]!))
  return Array.from(used).filter(tag => {
    if (RUNTIME_TAGS.has(tag)) return false
    return !new RegExp(`\\b${tag}\\b`).test(script)
  })
}

describe('SFC component resolution', () => {
  it('every PascalCase template tag is imported by its own SFC', () => {
    const offenders = vueFiles(SRC).flatMap(file => {
      const tags = unresolvedTags(readFileSync(file, 'utf8'))
      return tags.map(tag => `${relative(SRC, file)} uses <${tag}> without importing it`)
    })

    expect(offenders).toEqual([])
  })

  it('the scanner actually finds tags, so a broken regex cannot stay green', () => {
    const sample = [
      '<template>',
      '  <PageSidebar><aside /></PageSidebar>',
      '  <Teleport to="body" />',
      '</template>',
      '<script setup lang="ts">',
      "import Child from './Child.vue'",
      '</script>',
    ].join('\n')

    expect(unresolvedTags(sample)).toEqual(['PageSidebar'])
  })

  it('an imported tag is not reported', () => {
    const sample = [
      '<template>',
      '  <PageSidebar><aside /></PageSidebar>',
      '</template>',
      '<script setup lang="ts">',
      "import PageSidebar from '@/components/layout/PageSidebar.vue'",
      '</script>',
    ].join('\n')

    expect(unresolvedTags(sample)).toEqual([])
  })
})
