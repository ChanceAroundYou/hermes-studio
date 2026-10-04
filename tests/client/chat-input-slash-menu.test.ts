// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { toSkillPickerItems } from '../../packages/client/src/utils/hermes/slash-command-skills'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { setViewportWidth } from '../mocks/viewport'

enableAutoUnmount(afterEach)

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fetchEkkoSkillsMock = vi.hoisted(() => vi.fn())
const fetchSkillBundlesMock = vi.hoisted(() => vi.fn())
const deleteSkillBundleApiMock = vi.hoisted(() => vi.fn())
const dialogWarningMock = vi.hoisted(() => vi.fn())
const extractRepresentativeVideoFramesMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NSpin: { template: '<div role="status"><slot /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: {
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    props: ['value', 'min', 'max', 'step'],
    emits: ['update:value'],
    template: `
      <input
        class="n-slider-stub"
        type="range"
        :value="value"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  useDialog: () => ({ warning: dialogWarningMock }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionReasoningEffort: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

// Mocked separately from fetchSkills on purpose: an Ekko session loads a
// different registry through a different endpoint. When this mock was missing
// the three Ekko cases below passed for the wrong reason -- the real `request`
// ran in jsdom, failed silently, and the empty result happened to satisfy
// "no skills are offered".
// The real module is preserved so `isDispatchableEkkoSkill` still runs. Replacing
// the whole export with a bare array would hide that filter, and the "a skill
// with no metadata.keywords is excluded" case would then be asserting something
// the production path never does.
vi.mock('@/api/hermes/ekko-skills', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/hermes/ekko-skills')>()
  return {
    ...original,
    fetchEkkoSkills: async (profile: string) => {
      const raw = await fetchEkkoSkillsMock(profile)
      return (Array.isArray(raw) ? raw : []).filter(original.isDispatchableEkkoSkill)
    },
  }
})

vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: fetchSkillBundlesMock,
  deleteSkillBundleApi: deleteSkillBundleApiMock,
}))

vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: {
    name: 'BundleCreateModal',
    props: ['profile'],
    emits: ['close', 'created'],
    template: '<div class="bundle-create-modal">{{ profile }}</div>',
  },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

vi.mock('@/utils/video-frame-extraction', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/video-frame-extraction')>()
  return {
    ...original,
    extractRepresentativeVideoFrames: extractRepresentativeVideoFramesMock,
  }
})

function mountForSession(
  sessionId: string,
  skills: any[] = [],
  preload?: () => void,
  overrides: Record<string, any> = {},
) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...overrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  settingsStore.display = {}
  fetchSkillsMock.mockResolvedValue({
    categories: [{ name: 'software-development', description: 'dev', skills }],
    archived: [],
  })
  if (preload) preload()
  return mount(ChatInput, { global: { plugins: [pinia] } })
}

/** Types into the composer the way a user does, so updateSlashState actually runs. */
async function typeSlash(wrapper: any, text: string) {
  const textarea = wrapper.get('textarea')
  await textarea.setValue(text)
  await textarea.trigger('input')
  await flushPromises()
  await nextTick()
}

describe('slash menu renders built-in commands', () => {
  beforeEach(() => {
    localStorage.clear()
    setViewportWidth(1024)
    fetchSkillsMock.mockReset()
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    deleteSkillBundleApiMock.mockResolvedValue(undefined)
    dialogWarningMock.mockReset()
    extractRepresentativeVideoFramesMock.mockReset()
    extractRepresentativeVideoFramesMock.mockResolvedValue([])
  })

  it('shows the built-in /plan for a bridge session', async () => {
    const wrapper = mountForSession('session-slash-builtin')
    await typeSlash(wrapper, '/plan')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).toContain('/plan')
  })

  it('shows the built-in list for a bare slash', async () => {
    const wrapper = mountForSession('session-slash-bare')
    await typeSlash(wrapper, '/')
    expect(wrapper.findAll('.slash-command-item').length).toBeGreaterThan(0)
  })

  it('still shows built-ins when no skill is returned at all', async () => {
    const wrapper = mountForSession('session-slash-noskills', [])
    await typeSlash(wrapper, '/plan')
    expect(wrapper.findAll('.slash-command-name').map(n => n.text())).toContain('/plan')
  })

  it('shows a custom skill next to the built-in of the same prefix', async () => {
    const wrapper = mountForSession('session-slash-skill', [
      { name: 'plan only', description: 'Plan and stop', enabled: true },
    ])
    await typeSlash(wrapper, '/plan')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).toContain('/plan')
    expect(names).toContain('/plan-only')
  })
})

/**
 * A malformed skill entry must never take the whole menu down.
 *
 * skillPickerItems normalizes every name through skillCommandName, which calls
 * .trim(). One entry without a usable name throws inside the computed the menu
 * renders from, and Vue keeps the last good value -- so the DOM can look perfect
 * while the render is already failing. An earlier version of this file asserted
 * "the menu still renders" and every mutation of the guard passed it; asserting
 * on console.error did not work either, because @vue/test-utils swallows it.
 *
 * So this asserts the extracted production function directly.
 */
describe('a malformed skill cannot break the slash menu', () => {
  it('skips entries with no usable name instead of throwing', () => {
    expect(() => toSkillPickerItems([
      { name: 'software-development', skills: [{ description: 'nameless', enabled: true }] },
    ])).not.toThrow()
    expect(toSkillPickerItems([
      { name: 'software-development', skills: [{ description: 'nameless', enabled: true }] },
    ])).toEqual([])
  })

  it('survives a category list that is not the expected shape', () => {
    expect(() => toSkillPickerItems([null, undefined, 42, { name: 'no skills key' }])).not.toThrow()
    expect(toSkillPickerItems([null, undefined, 42, { name: 'no skills key' }])).toEqual([])
    expect(toSkillPickerItems(null)).toEqual([])
    expect(toSkillPickerItems(undefined)).toEqual([])
  })

  it('drops a name that normalizes to nothing rather than listing a dead entry', () => {
    const items = toSkillPickerItems([
      { name: 'c', skills: [{ name: '???', description: 'unusable', enabled: true }] },
    ])
    // Listed, this would insert a bare "/skill " that resolves to nothing.
    expect(items).toEqual([])
  })

  it('keeps the valid skills alongside a broken one', () => {
    const items = toSkillPickerItems([
      { name: 'c', skills: [
        { description: 'nameless', enabled: true },
        { name: 'plan only', description: 'Plan and stop', enabled: true },
      ] },
    ])
    expect(items.map(i => i.commandName)).toEqual(['plan-only'])
  })

  it('omits disabled skills', () => {
    const items = toSkillPickerItems([
      { name: 'c', skills: [{ name: 'off', description: 'off', enabled: false }] },
    ])
    expect(items).toEqual([])
  })

  it('lists one entry per command name across categories', () => {
    const items = toSkillPickerItems([
      { name: 'a', skills: [{ name: 'plan only', description: 'x', enabled: true }] },
      { name: 'b', skills: [{ name: 'plan-only', description: 'y', enabled: true }] },
    ])
    expect(items).toHaveLength(1)
  })
})

describe('the slash menu is reachable and the skill group is visible', () => {
  beforeEach(() => {
    localStorage.clear()
    setViewportWidth(1024)
    fetchSkillsMock.mockReset()
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    deleteSkillBundleApiMock.mockResolvedValue(undefined)
    dialogWarningMock.mockReset()
    extractRepresentativeVideoFramesMock.mockReset()
    extractRepresentativeVideoFramesMock.mockResolvedValue([])
  })

  it('marks the boundary between built-in commands and skills', async () => {
    const wrapper = mountForSession('session-slash-divider', [
      { name: 'plan only', description: 'Plan and stop', enabled: true },
    ])
    await typeSlash(wrapper, '/')
    // Built-ins come first, so without a divider the skills read as one
    // continuous list and nobody scrolls far enough to find them.
    expect(wrapper.findAll('.slash-command-divider').length).toBe(1)
  })

  it('logs why skills are missing instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Reject before mounting: loadSkills fires on the first "/" and is cached
    // per profile, so a rejection set after the mount would never be seen.
    const wrapper = mountForSession('session-slash-loadfail', [], () => {
      fetchSkillsMock.mockRejectedValue(new Error('boom'))
    })
    await typeSlash(wrapper, '/plan')
    // A swallowed load failure is indistinguishable from "this profile has no
    // custom skills", which is what made this undiagnosable from the outside.
    expect(warn.mock.calls.some(call => String(call[0]).includes('failed to load custom skills'))).toBe(true)
    warn.mockRestore()
  })

  it('gives the menu room to reach the skills at all', async () => {
    const wrapper = mountForSession('session-slash-height', [
      { name: 'plan only', description: 'Plan and stop', enabled: true },
    ])
    await typeSlash(wrapper, '/')
    const css = readFileSync('packages/client/src/components/hermes/chat/ChatInput.vue', 'utf8')
    const start = css.indexOf('.slash-command-dropdown {')
    const block = css.slice(start, css.indexOf('}', start))
    // 240px showed ~6 of the 22 built-ins, putting every skill ~880px down a
    // scroll box: reachable in principle, invisible in practice.
    expect(block).toMatch(/max-height:\s*min\(\d+px,\s*\d+vh\)/)
    expect(block).not.toMatch(/max-height:\s*240px/)
  })
})

/**
 * An Ekko session is `source: 'coding_agent'` with `agent: 'ekko-agent'`.
 *
 * This block used to assert the opposite. It claimed Ekko must NOT be offered
 * skills, because `/skill <name>` is inert there -- which was true, and was the
 * basis for a commit that hid 100+ skills behind a session-type check.
 *
 * The conclusion drawn from it was wrong. Ekko has its own registry at
 * `/api/ekko/skills` and injects valid skill NAMES into model context; the model
 * then loads the body with its own skill tool. So the working invocation in an
 * Ekko session is the bare name, not `/skill <name>`, and the fix is to offer
 * Ekko's skills rather than to hide every skill.
 */
describe('an Ekko session is offered the skills it can actually load', () => {
  beforeEach(() => {
    localStorage.clear()
    setViewportWidth(1024)
    fetchSkillsMock.mockReset()
    fetchEkkoSkillsMock.mockReset()
    fetchEkkoSkillsMock.mockResolvedValue([])
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    deleteSkillBundleApiMock.mockResolvedValue(undefined)
    dialogWarningMock.mockReset()
    extractRepresentativeVideoFramesMock.mockReset()
    extractRepresentativeVideoFramesMock.mockResolvedValue([])
  })

  const ekko = { source: 'coding_agent', agent: 'ekko-agent', codingAgentId: 'ekko-agent' }

  it('lists a skill Ekko can dispatch', async () => {
    fetchEkkoSkillsMock.mockResolvedValue([
      { name: 'plan-only', description: 'Plan and stop', category: 'software-development',
        source: 'external', enabled: true, managedByEkko: false, builtIn: false,
        validationStatus: 'valid' },
    ])
    const wrapper = mountForSession('session-ekko', [], undefined, ekko)
    await typeSlash(wrapper, '/plan')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).toContain('/plan-only')
  })

  it('does not prefix the entry, because Ekko dispatches by bare name', async () => {
    // `/skill plan-only` is inert in a coding-agent session
    // (isBridgeSlashCommand is `!isCodingAgentSession && ...`).
    fetchEkkoSkillsMock.mockResolvedValue([
      { name: 'plan-only', description: 'Plan and stop', category: 'software-development',
        source: 'external', enabled: true, managedByEkko: false, builtIn: false,
        validationStatus: 'valid' },
    ])
    const wrapper = mountForSession('session-ekko-bare', [], undefined, ekko)
    await typeSlash(wrapper, '/plan')
    const items = wrapper.findAll('.slash-command-item')
    const target = items.find(i => i.text().includes('/plan-only'))
    expect(target).toBeTruthy()
    expect(target!.attributes('data-insert-text') ?? '/plan-only ').not.toContain('/skill')
  })

  it('keeps the four coding-agent verbs alongside the skills', async () => {
    fetchEkkoSkillsMock.mockResolvedValue([
      { name: 'plan-only', description: 'Plan', category: 'software-development',
        source: 'external', enabled: true, managedByEkko: false, builtIn: false,
        validationStatus: 'valid' },
    ])
    const wrapper = mountForSession('session-ekko-verbs', [], undefined, ekko)
    await typeSlash(wrapper, '/')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    for (const verb of ['/context', '/compact', '/usage', '/status']) {
      expect(names).toContain(verb)
    }
    expect(names).toContain('/plan-only')
  })

  it('loads Ekko skills, not the Hermes registry', async () => {
    const wrapper = mountForSession('session-ekko-registry', [], undefined, ekko)
    await typeSlash(wrapper, '/plan')
    expect(fetchEkkoSkillsMock).toHaveBeenCalled()
    // The Hermes registry is a different set; fetching it here would mix them.
    expect(fetchSkillsMock).not.toHaveBeenCalled()
  })

  it('reloads for the new profile instead of reusing the cached one', async () => {
    // The cache is keyed by profile. Without the reset in the profile watcher,
    // switching profile leaves the previous profile's skills on screen -- the
    // entry still looks selectable and still loads nothing.
    const skillsFor = (profile: string) => profile === 'alpha'
      ? [{ name: 'plan-only', description: 'Plan', category: 'software-development',
           source: 'external', enabled: true, managedByEkko: false, builtIn: false,
           validationStatus: 'valid' }]
      : [{ name: 'weather', description: 'Forecast', category: 'misc', source: 'builtin',
           enabled: true, managedByEkko: false, builtIn: true, validationStatus: 'valid' }]

    fetchEkkoSkillsMock.mockImplementation(async (profile: string) => skillsFor(profile))

    const wrapper = mountForSession('session-ekko-cache', [], undefined, ekko)
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'alpha'

    await nextTick()
    await typeSlash(wrapper, '/')
    await flushPromises()
    await typeSlash(wrapper, '/')
    expect(wrapper.findAll('.slash-command-name').map(n => n.text())).toContain('/plan-only')

    profilesStore.activeProfileName = 'beta'
    await nextTick()
    await flushPromises()
    await typeSlash(wrapper, '/')
    await flushPromises()
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).toContain('/weather')
    expect(names).not.toContain('/plan-only')
    expect(fetchEkkoSkillsMock).toHaveBeenCalledWith('beta')
  })
})

describe('skills the host cannot dispatch stay out of the Ekko menu', () => {
  beforeEach(() => {
    localStorage.clear()
    setViewportWidth(1024)
    fetchSkillsMock.mockReset()
    fetchEkkoSkillsMock.mockReset()
    fetchEkkoSkillsMock.mockResolvedValue([])
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    deleteSkillBundleApiMock.mockResolvedValue(undefined)
    dialogWarningMock.mockReset()
    extractRepresentativeVideoFramesMock.mockReset()
    extractRepresentativeVideoFramesMock.mockResolvedValue([])
  })

  const ekko = { source: 'coding_agent', agent: 'ekko-agent', codingAgentId: 'ekko-agent' }
  const base = { category: 'software-development', source: 'external', enabled: true,
                 managedByEkko: false, builtIn: false }

  it('omits a skill with no metadata.keywords', async () => {
    // Listed by the API, but the host never routes it to the model. Offering it
    // rebuilds the dead-entry bug this feature replaced.
    fetchEkkoSkillsMock.mockResolvedValue([
      { ...base, name: 'no-keywords', description: 'x', validationStatus: 'needs_metadata' },
    ])
    const wrapper = mountForSession('session-ekko-nokw', [], undefined, ekko)
    await typeSlash(wrapper, '/')
    expect(wrapper.findAll('.slash-command-name').map(n => n.text())).not.toContain('/no-keywords')
  })

  it('omits a malformed skill instead of failing the menu', async () => {
    fetchEkkoSkillsMock.mockResolvedValue([
      { ...base, name: 'ok-skill', description: 'x', validationStatus: 'valid' },
      { ...base, name: '', description: 'x', validationStatus: 'valid' },
      null,
    ])
    const wrapper = mountForSession('session-ekko-bad', [], undefined, ekko)
    await typeSlash(wrapper, '/')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).toContain('/ok-skill')
    // Built-ins survive: one bad row must not take the menu down.
    expect(names).toContain('/context')
  })
})
