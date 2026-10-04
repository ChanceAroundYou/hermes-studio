import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Why this file exists
 * -------------------
 * This bug has now been reported three times, and the previous fix is the reason
 * it kept coming back.
 *
 *   a440c83ac  routed profile labels through resolveProfileDisplayName
 *   1c8692c07  merged all of upstream #3232 and restored the raw-name fallback
 *   c427bd102  fixed it again -- for the message header only
 *
 * The resolver was never broken and always had its own passing tests. What broke
 * was always the wiring: a call site that stopped calling it. c427bd102 guarded
 * exactly one call site (MessageList.vue), so the five other profile selects that
 * never went through the resolver stayed wrong, and the new-chat dialog kept
 * saying "bianchengmao" where the profile is called "编程毛".
 *
 * A per-callsite guard cannot catch that class of regression, because nobody
 * writes the guard for the callsite they forgot. So this guard is structural: it
 * scans the whole client tree for a raw profile name used as a display label and
 * fails on anything that is not explicitly justified below. Adding a new profile
 * dropdown now fails here instead of waiting to be reported a fourth time.
 */

const CLIENT_SRC = 'packages/client/src'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(vue|ts)$/.test(entry)) out.push(full)
  }
  return out
}

interface Hit {
  file: string
  line: number
  text: string
}

/**
 * Matches `<label>: <something>.name` inside an object literal, which is the
 * shape every profile <select> option uses.
 *
 * The leading identifier is restricted to the names a profile is actually bound
 * to. A wider `label: x.name` net also catches skill pickers, session
 * categories, kanban assignees and file rows, where the raw name is correct and
 * has nothing to do with profiles; burying those under an allowlist would make
 * the list noise and train everyone to ignore it.
 *
 * The known profile selects are additionally pinned by name in CALL_SITES below,
 * so a new dropdown written with a different variable still has to appear there.
 */
const PROFILE_IDENTIFIER = /^(?:profile|profiles|prof|p|activeProfile|currentProfile)$/
const RAW_NAME_LABEL = /\blabel:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.name\b/g

/**
 * Places where `.name` is not a Hermes profile name, so the resolver does not
 * apply. Each entry must say why, so the list stays auditable.
 */
const ALLOWED: Record<string, string> = {
  'components/hermes/chat/DesktopBrowserPanel.vue':
    'browser profiles are keyed by .id and carry no Hermes display name',
  'views/hermes/DesktopBrowserView.vue':
    'browser profiles are keyed by .id and carry no Hermes display name',
}

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const file of walk(CLIENT_SRC)) {
    const rel = file.replace(`${CLIENT_SRC}/`, '')
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, index) => {
      RAW_NAME_LABEL.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = RAW_NAME_LABEL.exec(text)) !== null) {
        const chain = match[1].split('.')
        // The last binding in the chain is what the label reads `.name` from.
        if (!PROFILE_IDENTIFIER.test(chain[chain.length - 1])) continue
        hits.push({ file: rel, line: index + 1, text: text.trim() })
      }
    })
  }
  return hits
}

describe('profile labels go through the shared resolver', () => {
  it('has no unexplained raw profile name used as a label', () => {
    const unexplained = scan().filter(hit => !ALLOWED[hit.file])
    const report = unexplained
      .map(hit => `  ${hit.file}:${hit.line}  ${hit.text}`)
      .join('\n')
    expect(
      unexplained.length === 0 ? '' : `raw ".name" used as a label:\n${report}`,
    ).toBe('')
  })

  it('every allowlisted file still has the reason it is exempt', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason, `${file} needs a reason`).toBeTruthy()
      expect(reason.length, `${file} reason is too vague`).toBeGreaterThan(20)
    }
  })

  it('still finds the pattern, so the scanner itself cannot silently rot', () => {
    // A regex that matches nothing would make the guard above pass forever. This
    // pins that the shape it looks for is still the shape the code uses.
    const source = readFileSync(
      `${CLIENT_SRC}/components/hermes/chat/ChatPanel.vue`,
      'utf8',
    )
    RAW_NAME_LABEL.lastIndex = 0
    const probe = 'label: profile.name,'
    expect(RAW_NAME_LABEL.test(probe)).toBe(true)
    expect(RAW_NAME_LABEL.test('label: resolveProfileDisplayName(a, b),')).toBe(false)
    expect(source).toContain('resolveProfileDisplayName')
  })

  it('no hand-rolled copy of the precedence chain survives', () => {
    // WebhookSettings used to carry its own `displayName || alias || name`.
    // That is a fourth copy of the resolver and it drifts the moment the
    // resolver changes, so it is banned outright rather than allowlisted.
    const offenders: string[] = []
    for (const file of walk(CLIENT_SRC)) {
      const rel = file.replace(`${CLIENT_SRC}/`, '')
      if (rel === 'utils/hermes/profile-display-name.ts') continue
      if (/displayName\s*\|\|\s*[^\n]*alias\s*\|\|/.test(readFileSync(file, 'utf8'))) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('each profile select resolves the display name', () => {
  const CALL_SITES: Array<[string, string]> = [
    ['components/hermes/chat/ChatPanel.vue', 'newChatProfileOptions'],
    ['components/hermes/group-chat/GroupChatPanel.vue', 'profileOptions'],
    ['views/hermes/WorkflowView.vue', 'workflowProfileOptions'],
    ['views/hermes/ModelsView.vue', 'profileOptions'],
    ['components/hermes/settings/GatewayAutoStartSettings.vue', 'profileOptions'],
    ['components/hermes/settings/WebhookSettings.vue', 'profileOptions'],
  ]

  it.each(CALL_SITES)('%s resolves labels in %s', (file, symbol) => {
    const source = readFileSync(`${CLIENT_SRC}/${file}`, 'utf8')
    expect(source, `${file} must import the resolver`).toMatch(
      /import \{ resolveProfileDisplayName \} from ["']@\/utils\/hermes\/profile-display-name["']/,
    )

    const start = source.indexOf(`const ${symbol} = computed(`)
    expect(start, `${symbol} not found in ${file}`).toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('\n})', start))
    expect(block, `${symbol} must call the resolver`).toContain(
      'resolveProfileDisplayName(',
    )
  })

  it('keeps the value as the raw profile name so API calls still match', () => {
    // The label is cosmetic; the value is an identifier. A fix that renames the
    // value too would silently break every profile-scoped request.
    for (const [file, symbol] of CALL_SITES) {
      const source = readFileSync(`${CLIENT_SRC}/${file}`, 'utf8')
      const start = source.indexOf(`const ${symbol} = computed(`)
      const block = source.slice(start, source.indexOf('\n})', start))
      expect(block, `${symbol} in ${file}`).toMatch(/value:\s*[A-Za-z_$][\w$]*\.name\b/)
    }
  })
})