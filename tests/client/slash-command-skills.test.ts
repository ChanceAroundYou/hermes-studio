// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  rewriteSkillSlashCommand,
  mergeSkillSlashCommands,
  skillCommandName,
  skillToSlashCommand,
  slashCommandInsertText,
  type SlashCommandOption,
} from '../../packages/client/src/utils/hermes/slash-command-skills'

/**
 * The slash menu offered only the hard-coded bridge commands, so a custom skill
 * was reachable solely by typing /skill and picking from a second dialog.
 *
 * The subtle rule is what gets inserted. A bare "/plan-only" is not a known
 * bridge command, so the store sends it as an ordinary user message and the
 * Agent never loads the skill. Menu entries therefore search on the skill's
 * command name but insert "/skill <command-name>".
 *
 * These tests import the real module the composer uses. An earlier draft
 * reproduced the logic inline, which meant the behaviour tests passed no matter
 * what the component did -- the same trap recorded in
 * docs/fork-customization-discipline.md.
 */

const builtin = (name: string): SlashCommandOption => ({
  key: `command:${name}`,
  name,
  args: '',
  description: `builtin ${name}`,
})

const skill = (name: string, commandName = skillCommandName(name)): SlashCommandOption =>
  skillToSlashCommand({ name, commandName, description: `skill ${name}` })

/** Mirrors the filter applied to the merged list in ChatInput.vue. */
function search(commands: SlashCommandOption[], query: string): SlashCommandOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((command) => {
    const name = command.name.toLowerCase()
    const insertText = command.insertText?.toLowerCase()
    const description = command.description.toLowerCase()
    return name.startsWith(q) || insertText?.startsWith(q) || description.includes(q)
  })
}

describe('custom skills are offered in the slash command menu', () => {
  it('lists custom skills alongside built-in commands', () => {
    const merged = mergeSkillSlashCommands(
      [builtin('usage'), builtin('skill')],
      [skill('plan only'), skill('root cause')],
    )
    // "root cause" normalizes to "root-cause": spaces become dashes. This is the
    // same rule the /skill command applies, so the menu cannot offer a token the
    // Agent would reject.
    expect(merged.map(c => c.name)).toEqual(['usage', 'skill', 'plan-only', 'root-cause'])
    expect(slashCommandInsertText(merged[3])).toBe('/root-cause ')
  })

  it('inserts the command name itself; the store rewrites it to /skill <name>', () => {
    expect(slashCommandInsertText(skill('plan only'))).toBe('/plan-only ')
  })

  it('finds a skill by the command name the user already knows', () => {
    const merged = mergeSkillSlashCommands([builtin('plan')], [skill('plan only')])
    // Typing "plan" must surface the skill, otherwise the fix does nothing for
    // the user who typed the prefix they expected to work.
    expect(search(merged, 'plan').map(c => c.name)).toContain('plan-only')
  })

  it('lets built-in commands win a name clash', () => {
    // /plan changes how the run is executed; a skill named "plan" must not shadow it.
    const merged = mergeSkillSlashCommands([builtin('plan')], [skill('plan')])
    expect(merged.filter(c => c.name === 'plan')).toHaveLength(1)
    expect(merged[0].skill).toBeUndefined()
  })

  it('drops skills with no usable command name', () => {
    expect(mergeSkillSlashCommands([], [skill('***')])).toEqual([])
  })

  it('lists a skill once when it appears in several categories', () => {
    const merged = mergeSkillSlashCommands([], [skill('plan only'), skill('plan only')])
    expect(merged.map(c => c.name)).toEqual(['plan-only'])
  })
})

describe('the chat composer wires skills into the slash menu', () => {
  const chatInput = readFileSync(
    join(process.cwd(), 'packages/client/src/components/hermes/chat/ChatInput.vue'),
    'utf8',
  )

  it('builds skill menu entries from the shared module', () => {
    expect(chatInput).toMatch(/skillPickerItems\.value\.map\(skillToSlashCommand\)/)
  })

  it('merges skills into the bridge session list', () => {
    expect(chatInput).toMatch(
      /mergeSkillSlashCommands\(bridgeCommands\.value,\s*skillSlashCommands\.value\)/,
    )
  })

  it('inserts through the shared helper rather than an inline template', () => {
    expect(chatInput).toContain('slashCommandInsertText(command)')
  })

  it('fetches skills when the menu opens, not only when /skill is picked', () => {
    // Without the prefetch the menu renders before the skills arrive and the
    // entries never appear until the second dialog has been opened once.
    // Bound the slice at the next function: loadSkills() is also called by
    // openSkillPicker, so an unbounded slice would match either one.
    const start = chatInput.indexOf('function updateSlashState')
    const body = chatInput.slice(start, chatInput.indexOf('\nfunction ', start + 10))
    expect(body).toMatch(/void loadSkills\(\)/)
  })
})

/**
 * The wire contract.
 *
 * The composer inserts `/plan-only` because that is what the menu displays. That
 * bare form is not a known bridge command, so without a rewrite the store sends
 * it as an ordinary user message: the Agent receives the text and never loads
 * the skill. Everything here exists to make that rewrite reliable.
 */
describe('a bare skill command is rewritten to the form the Agent resolves', () => {
  const known = new Set(['plan-only', 'root-cause'])

  it('rewrites the exact form the menu inserts', () => {
    // The menu's trailing space is normalized away: the store trims for the wire
    // regardless, so preserving it would only hide a difference that is not one.
    expect(rewriteSkillSlashCommand('/plan-only ', known)).toBe('/skill plan-only')
  })

  it('rewrites a hand-typed command identically', () => {
    // The whole point of pushing the rewrite down: selecting from the menu and
    // typing it must not differ.
    expect(rewriteSkillSlashCommand('/plan-only', known))
      .toBe(rewriteSkillSlashCommand('/plan-only ', known))
  })

  it('keeps trailing instructions attached to the skill', () => {
    expect(rewriteSkillSlashCommand('/plan-only 先看看登录流程', known))
      .toBe('/skill plan-only 先看看登录流程')
  })

  it('leaves a built-in command alone even when a skill shares its prefix', () => {
    // `/plan` changes how the run executes; it must never be captured as a skill.
    expect(rewriteSkillSlashCommand('/plan something', known)).toBe('/plan something')
    expect(rewriteSkillSlashCommand('/plan', known)).toBe('/plan')
  })

  it('leaves the already-rewritten form untouched', () => {
    expect(rewriteSkillSlashCommand('/skill plan-only', known)).toBe('/skill plan-only')
    expect(rewriteSkillSlashCommand('/skill plan-only 说明', known)).toBe('/skill plan-only 说明')
  })

  it('leaves an unknown command alone so it reaches the Agent as typed', () => {
    expect(rewriteSkillSlashCommand('/not-a-skill', known)).toBe('/not-a-skill')
    expect(rewriteSkillSlashCommand('/', known)).toBe('/')
    expect(rewriteSkillSlashCommand('hello', known)).toBe('hello')
    expect(rewriteSkillSlashCommand('', known)).toBe('')
  })

  it('accepts an array as well as a Set', () => {
    expect(rewriteSkillSlashCommand('/plan-only', ['plan-only'])).toBe('/skill plan-only')
  })
})

describe('the menu shows and inserts the same text', () => {
  it('carries no insertText override, so the name is what gets typed', () => {
    const option = skillToSlashCommand({ name: 'plan only', commandName: 'plan-only', description: 'x' })
    // The substitution used to live here, which meant the composer produced text
    // the user never saw and could not predict.
    expect(option.insertText).toBeUndefined()
    expect(slashCommandInsertText(option)).toBe('/plan-only ')
  })

  it('and that text is exactly what the store then rewrites', () => {
    const option = skillToSlashCommand({ name: 'plan only', commandName: 'plan-only', description: 'x' })
    const typed = slashCommandInsertText(option)
    expect(rewriteSkillSlashCommand(typed, new Set(['plan-only']))).toBe('/skill plan-only')
  })
})

describe('the composer reports loaded skills to the store', () => {
  it('registers the command names after a successful load', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatInput.vue', 'utf8')
    expect(source).toContain('setKnownSkillCommandNames(')
  })

  it('and the store uses them when deciding what goes on the wire', () => {
    const source = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')
    expect(source).toContain('rewriteSkillSlashCommand(')
    expect(source).toContain('knownSkillCommandNames.value')
    // Session-type gate: an Ekko session dispatches skills by bare name and has
    // no /skill command, so the rewrite must not run there. Asserted as wiring
    // rather than as one source literal, so reformatting cannot silently pass.
    const call = source.slice(source.indexOf('const trimmedContent = rewriteSkillSlashCommand('))
    expect(call.slice(0, 600)).toContain("source === 'cli'")
  })
})
