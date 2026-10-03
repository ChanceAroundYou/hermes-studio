// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'packages/client/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(vue|ts)$/.test(entry)) out.push(full)
  }
  return out
}

// A leading "/" or "./" resolves against the server root rather than the app's
// subpath, so a /hermes/ build 404s on every agent icon written that way. That
// is how DSH, Cursor and OpenCode lost their icons.
const BARE = /(?:src|logo|icon)\s*[:=]\s*['"]\.?\/?(?:coding-agents\/|logo\.png)/

describe('agent icon paths survive a subpath build', () => {
  it('never hardcodes a root-relative coding-agents asset path', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (BARE.test(line)) offenders.push(`${file.replace(SRC, 'src')}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('prefixes the root-level brand logo too', () => {
    // #3257 added relay-logo.png with a root-relative src, which 404s on a
    // /hermes/ build exactly like the agent icons did. relay-logo.png and its
    // entry point are gone now; logo.png stays and keeps the same rule.
    const files = walk(SRC).filter(f => readFileSync(f, 'utf8').includes('const logoSrc = '))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const line = readFileSync(file, 'utf8').split('\n').find(l => l.includes('const logoSrc = '))!
      expect(line).toContain('getBaseUrlValue()')
    }
  })

  it('serves every icon the avatar map references from public/', () => {
    const src = readFileSync(join(SRC, 'utils/chat-agent-avatar.ts'), 'utf8')
    const names = [...src.matchAll(/coding-agents\/([^'"`]+\.(?:svg|png))/g)].map(m => m[1])
    expect(names.length).toBeGreaterThan(0)
    const missing = names.filter(
      n => !statSync(join(process.cwd(), 'packages/client/public/coding-agents', n), { throwIfNoEntry: false }),
    )
    expect(missing).toEqual([])
  })
})
