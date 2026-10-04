export type SlashCommandOption = {
  name: string
  args: string
  description: string
  insertText?: string
  key: string
  opensSkillPicker?: boolean
  opensBundlePicker?: boolean
  opensBundleCreator?: boolean
  /** A custom skill surfaced in the menu rather than a bridge session command. */
  skill?: boolean
}

/** Normalize a skill name into the token the `/skill` command accepts. */
export function skillCommandName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Turn one skill into a menu entry.
 *
 * The menu shows and inserts `/commandName` alike. A bare "/plan-only" is not a
 * known bridge command, so `rewriteSkillSlashCommand` in the store turns it into
 * "/skill plan-only" before the Agent sees it.
 */
export function skillToSlashCommand(skill: { name: string; commandName: string; description: string }): SlashCommandOption {
  return {
    key: `skill:${skill.commandName}`,
    name: skill.commandName,
    args: '',
    description: skill.description,
    // No insertText override: the menu inserts `/plan-only`, the same shape it
    // displays and the same shape every built-in uses. The rewrite to
    // `/skill plan-only` happens in the store, at the point that decides what
    // goes on the wire, so hand-typing the command works identically.
    skill: true,
  }
}

/**
 * Merge custom skills into the built-in command list.
 *
 * Built-ins win any name clash: /plan changes how the run is executed, so a
 * skill named "plan" must not shadow it. Skills with no usable command name are
 * dropped -- they would insert a bare "/skill " that resolves to nothing.
 */
export function mergeSkillSlashCommands(
  commands: SlashCommandOption[],
  skills: SlashCommandOption[],
): SlashCommandOption[] {
  const taken = new Set(commands.flatMap(command => [command.name, command.insertText]))
  const merged = [...commands]
  const seen = new Set<string>()
  for (const skill of skills) {
    if (!skill.name || taken.has(skill.name) || seen.has(skill.name)) continue
    seen.add(skill.name)
    merged.push(skill)
  }
  return merged
}

/** The text a menu selection puts in the composer. */
export function slashCommandInsertText(command: SlashCommandOption): string {
  return `/${command.insertText || command.name} `
}

export interface SkillLike {
  name: string
  description?: string
  enabled?: boolean
}

export interface SkillPickerEntry {
  key: string
  name: string
  commandName: string
  description: string
}

/**
 * Flatten the skill categories into menu-ready entries.
 *
 * The payload is scanned off disk, so a malformed entry is possible, and this
 * feeds a computed the slash menu renders from. One throw inside that computed
 * fails the whole render, which takes the built-in commands down too and presents
 * as "the slash menu is dead". Skipping a bad row costs one invisible skill;
 * letting it through costs the entire menu, so every field is checked before use.
 */
export function toSkillPickerItems(categories: unknown): SkillPickerEntry[] {
  const byName = new Map<string, SkillLike>()
  for (const category of (Array.isArray(categories) ? categories : []) as any[]) {
    if (!category || !Array.isArray(category.skills)) continue
    for (const skill of category.skills as any[]) {
      if (!skill || typeof skill.name !== 'string' || !skill.name.trim()) continue
      if (skill.enabled === false) continue
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  const entries: SkillPickerEntry[] = []
  const seen = new Set<string>()
  for (const skill of byName.values()) {
    const commandName = skillCommandName(skill.name)
    // skillCommandName strips anything unusable, so a name like "???" normalizes
    // to an empty token and would insert a bare "/skill " that resolves to
    // nothing. Drop it here instead of listing a dead entry.
    if (!commandName || seen.has(commandName)) continue
    seen.add(commandName)
    entries.push({
      key: `skill:${commandName}`,
      name: skill.name,
      commandName,
      description: skill.description || skill.name,
    })
  }
  return entries
}

/**
 * Rewrites a bare skill invocation into the form the Agent resolves.
 *
 * The menu shows `/plan-only` and must insert exactly that -- what you see is
 * what you type, the same contract every built-in command already honours. But
 * a bare `/plan-only` is not a known bridge command, so `isKnownBridgeSessionCommand`
 * rejects it and the store would send it as an ordinary user message. The Agent
 * would receive the text and never load the skill.
 *
 * So the substitution lives here, at the one place that decides what actually
 * goes on the wire, instead of inside the menu item that the user never sees
 * the inside of. Two things follow:
 *
 *   - typing `/plan-only` by hand works, not only selecting it from the menu
 *   - there is exactly one rule to change if the Agent's skill syntax ever moves
 *
 * Returns the original input when it is not a skill invocation, when the skill
 * name is unknown, or when it already uses the `/skill` form.
 */
export function rewriteSkillSlashCommand(
  input: string,
  knownSkillNames: Iterable<string>,
): string {
  const known = knownSkillNames instanceof Set
    ? knownSkillNames
    : new Set(knownSkillNames)
  const trimmed = (input ?? '').trim()
  if (!trimmed.startsWith('/')) return input
  // Already the executable form, or a built-in that happens to be named like a
  // skill (`/skill`, `/plan`, ...) -- leave both alone.
  if (/^\/skill(?:\s|$)/i.test(trimmed)) return input

  const match = /^\/([^\s]+)([\s\S]*)$/.exec(trimmed)
  if (!match) return input
  const token = match[1]
  const rest = match[2] ?? ''
  // A bare `/` or a name with no usable token cannot be a skill.
  if (!token) return input
  if (!known.has(token)) return input
  return `/skill ${token}${rest}`
}
