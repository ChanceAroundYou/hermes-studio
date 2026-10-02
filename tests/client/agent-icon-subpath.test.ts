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
const BARE = /(?:src|logo|icon)\s*[:=]\s*['"]\.?\/?coding-agents\//

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
