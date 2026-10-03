// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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
    expect(slashCommandInsertText(merged[3])).toBe('/skill root-cause ')
  })

  it('inserts /skill <command-name>, the only form the Agent resolves', () => {
    expect(slashCommandInsertText(skill('plan only'))).toBe('/skill plan-only ')
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
