/**
 * Inserts missing i18n keys into the locale files.
 *
 *   npx vite-node scripts/i18n-apply.ts patch.json
 *
 * `patch.json` is `{ "<locale>": { "<dotted.path>": "<translation>", ... } }`.
 * A key that is already present is skipped, so re-running is safe, and existing
 * members keep their formatting: only new lines are added, just before the
 * closing brace of the innermost object the path resolves to.
 */
import fs from 'node:fs'
import path from 'node:path'

type Patch = Record<string, Record<string, string>>
interface Frame { open: number; close: number; indent: number }

const repoRoot = path.resolve(import.meta.dirname, '..')
const localesDir = path.join(repoRoot, 'packages/client/src/i18n/locales')

/** Index of the `}` matching the `{` at `start`, skipping string literals. */
function matchingBrace(text: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced braces in a locale file')
}

/**
 * The `name: {` object that sits exactly `indent` spaces in, within `from..to`.
 *
 * The indentation matters: a file can contain several objects with the same name
 * at different depths, and the nested ones must not capture the path.
 */
function findObject(text: string, from: number, to: number, name: string, indent: number): Frame | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opener = new RegExp(`^${' '.repeat(indent)}${escaped}\\s*:\\s*\\{`, 'gm')
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    if (match.index >= to) break
    const open = text.indexOf('{', match.index)
    return { open, close: matchingBrace(text, open), indent }
  }
  return null
}

function indentOf(text: string, frame: Frame, fallback: string): string {
  const body = text.slice(frame.open + 1, frame.close)
  const match = /^([ \t]+)\S/m.exec(body)
  return match ? match[1] : fallback
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Insert member lines before the closing brace of `frame`.
 *
 * `members` carry *relative* indentation; the frame's member indent is applied
 * here, exactly once, so a nested block keeps the depth it was built for.
 */
function insertIntoFrame(text: string, frame: Frame, members: string[], inlineMembers: string[]): string {
  const before = text.slice(0, frame.close)
  const after = text.slice(frame.close)
  const singleLine = !text.slice(frame.open, frame.close).includes('\n')

  if (singleLine && inlineMembers.length) {
    const needsComma = /[^,\s]\s*$/.test(before)
    return `${before}${needsComma ? ', ' : ''}${inlineMembers.join(', ')}${after}`
  }
  const indent = indentOf(text, frame, '    ')
  const block = members.map(member => `${indent}${member}`).join('\n')
  // `before` normally ends with the newline + indent of the closing brace; keep
  // that railing so the new members land on their own lines, without a stray
  // whitespace-only line.
  const railing = /(\n[ \t]*)$/.exec(before)
  const closingIndent = railing ? railing[1] : '\n'
  let body = before.slice(0, before.length - closingIndent.length)
  // Expanding a single-line object needs a comma after its last member.
  if (!/[,\s{]\s*$/.test(body)) body = `${body},`
  return `${body}\n${block}${closingIndent}${after}`
}

/** Nest `leaf` under the missing `tail` objects, with relative indentation. */
function nestMissing(tail: string[], leaf: string, value: string): string[] {
  const pad = (levels: number) => '  '.repeat(levels)
  const lines: string[] = []
  tail.forEach((segment, index) => {
    lines.push(`${pad(index)}${segment}: {`)
  })
  lines.push(`${pad(tail.length)}${leaf}: ${quote(value)},`)
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    lines.push(`${pad(index)}},`)
  }
  return lines
}

/** Resolve every object frame a dotted path names, outermost first. */
function resolveFrames(text: string, segments: string[]): Frame[] {
  const frames: Frame[] = []
  let from = 0
  let to = text.length
  let indent = 2
  for (const segment of segments) {
    const found = findObject(text, from, to, segment, indent)
    if (!found) break
    frames.push(found)
    from = found.open + 1
    to = found.close
    indent += 2
  }
  return frames
}

/** Is `leaf` already a member of the innermost object the path resolves to? */
function leafExists(text: string, frames: Frame[], segments: string[], leaf: string): boolean {
  if (frames.length !== segments.length) return false
  const frame = frames[frames.length - 1]
  const body = text.slice(frame.open + 1, frame.close)
  const name = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // A member of this object sits exactly one level in, so its indentation
  // identifies it; a deeper `title:` belongs to a nested object.
  const memberIndent = ' '.repeat(frame.indent + 2)
  if (new RegExp(`^${memberIndent}['"]?${name}['"]?\\s*:`, 'm').test(body)) return true

  // Single-line objects keep their members inline.
  const singleLine = !body.includes('\n')
  return singleLine
    ? new RegExp(`(?:^|[{,\\s])['"]?${name}['"]?\\s*:`).test(body)
    : false
}

function applyKey(text: string, dotted: string, value: string): string {
  const segments = dotted.split('.')
  const leaf = segments.pop() as string

  const frames = resolveFrames(text, segments)

  if (frames.length === segments.length) {
    const frame = frames[frames.length - 1]
    return insertIntoFrame(text, frame, [`${leaf}: ${quote(value)},`], [`"${leaf}": ${JSON.stringify(value)}`])
  }

  const depth = frames.length
  const nested = nestMissing(segments.slice(depth), leaf, value)
  if (depth === 0) {
    // A brand new top-level namespace sits two spaces in.
    const end = text.lastIndexOf('}')
    const before = text.slice(0, end)
    const pad = /[,\s{]\s*$/.test(before) ? '' : ','
    const block = `${nested.map(line => `  ${line}`).join('\n')}\n`
    return `${before}${pad}${block}${text.slice(end)}`
  }
  return insertIntoFrame(text, frames[depth - 1], nested, [])
}

const patchPath = process.argv[2]
if (!patchPath) {
  console.error('usage: vite-node scripts/i18n-apply.ts patch.json')
  process.exit(1)
}

const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8')) as Patch
let total = 0

for (const [locale, entries] of Object.entries(patch)) {
  const file = path.join(localesDir, `${locale}.ts`)
  let text = fs.readFileSync(file, 'utf8')
  let added = 0

  for (const [dotted, value] of Object.entries(entries)) {
    const segments = dotted.split('.')
    const leaf = segments.pop() as string
    // Already present *inside its own object*? Then there is nothing to do,
    // which also keeps re-running safe.
    if (leafExists(text, resolveFrames(text, segments), segments, leaf)) continue
    text = applyKey(text, dotted, value)
    added += 1
  }

  fs.writeFileSync(file, text)
  total += added
  console.log(`${locale}: +${added}`)
}

console.log(`added ${total} keys`)
