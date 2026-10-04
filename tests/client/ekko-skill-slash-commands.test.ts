// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  isDispatchableEkkoSkill,
  type EkkoSkillInfo,
} from '../../packages/client/src/api/hermes/ekko-skills'
import {
  mergeSkillSlashCommands,
  rewriteSkillSlashCommand,
  skillCommandName,
  skillToSlashCommand,
  type SlashCommandOption,
} from '../../packages/client/src/utils/hermes/slash-command-skills'

function skill(over: Partial<EkkoSkillInfo> = {}): EkkoSkillInfo {
  return {
    name: 'plan-only',
    description: 'only a plan',
    category: 'software-development',
    source: 'external',
    enabled: true,
    managedByEkko: false,
    builtIn: false,
    validationStatus: 'valid',
    ...over,
  }
}

/** Mirror of the component's flattening, so the tests assert the same rule the
 *  production computed applies. The component itself is covered by the mount
 *  suite; this pins the selection rule independently. */
function dispatchable(skills: EkkoSkillInfo[]) {
  return skills
    .filter(isDispatchableEkkoSkill)
    .map(s => skillToSlashCommand({ name: s.name, commandName: skillCommandName(s.name), description: s.description }))
}

describe('Ekko skill dispatch surface', () => {
  it('offers a valid enabled skill as a bare /<name> entry', () => {
    const [entry] = dispatchable([skill()])
    expect(entry.name).toBe('plan-only')
    // Ekko has no /skill command; the bare name is the invocation.
    expect(entry.insertText).toBeUndefined()
  })

  it('refuses a skill the host cannot route to the model', () => {
    // needs_metadata: listed by the API, but no metadata.keywords, so the host
    // never dispatches it. Offering it would be a dead menu entry.
    expect(dispatchable([skill({ validationStatus: 'needs_metadata' })])).toEqual([])
    expect(dispatchable([skill({ validationStatus: 'invalid' })])).toEqual([])
    expect(dispatchable([skill({ enabled: false })])).toEqual([])
  })

  it('keeps built-in coding-agent commands and never shadows them', () => {
    const builtins: SlashCommandOption[] = [
      { key: 'usage', name: 'usage', args: '', description: 'usage' },
    ]
    const merged = mergeSkillSlashCommands(builtins, dispatchable([skill({ name: 'usage' })]))
    expect(merged.map(c => c.name)).toEqual(['usage'])
    expect(merged[0]).toBe(builtins[0])
  })

  it('lists plan-only alongside the four coding-agent built-ins', () => {
    const builtins: SlashCommandOption[] = ['context', 'compact', 'usage', 'status'].map(name => ({
      key: name, name, args: '', description: name,
    }))
    const merged = mergeSkillSlashCommands(builtins, dispatchable([skill()]))
    expect(merged.map(c => c.name)).toEqual(['context', 'compact', 'usage', 'status', 'plan-only'])
  })
})

describe('wire form per session type', () => {
  it('leaves an Ekko invocation untouched (no /skill prefix)', () => {
    // This is the regression that made Ekko skills unusable: the store rewrote
    // the name into a token the coding-agent path never resolves.
    const out = rewriteSkillSlashCommand('/plan-only 设计评审', ['plan-only'], false)
    expect(out).toBe('/plan-only 设计评审')
    expect(out).not.toContain('/skill')
  })

  it('still rewrites for a bridge session', () => {
    expect(rewriteSkillSlashCommand('/plan-only 评审', ['plan-only'], true)).toBe('/skill plan-only 评审')
  })

  it('never rewrites a built-in in either session type', () => {
    expect(rewriteSkillSlashCommand('/plan 评审', ['plan'], false)).toBe('/plan 评审')
    expect(rewriteSkillSlashCommand('/compact', ['compact'], false)).toBe('/compact')
  })
})
