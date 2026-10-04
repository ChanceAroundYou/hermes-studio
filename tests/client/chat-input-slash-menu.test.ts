// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { toSkillPickerItems } from '../../packages/client/src/utils/hermes/slash-command-skills'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { setViewportWidth } from '../mocks/viewport'

enableAutoUnmount(afterEach)

const fetchSkillsMock = vi.hoisted(() => vi.fn())
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
 * An Ekko session is `source: 'coding_agent'` with `agent: 'ekko-agent'`. The
 * skill merge used to be gated on `source === 'cli'`, so Ekko fell through to the
 * coding-agent branch, which offers four Studio-handled verbs and never calls
 * mergeSkillSlashCommands. The menu still worked, which is why this read as
 * "skills are broken" instead of "skills were never wired to this session type".
 */
describe('an Ekko session gets the custom skills too', () => {
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

  const ekko = { source: 'coding_agent', agent: 'ekko-agent', codingAgentId: 'ekko-agent' }

  it('lists skills for an ekko session', async () => {
    const wrapper = mountForSession('session-ekko', [
      { name: 'plan only', description: 'Plan and stop', enabled: true },
    ], undefined, ekko)
    await typeSlash(wrapper, '/plan')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).toContain('/plan-only')
  })

  it('keeps the four coding-agent verbs for an ekko session', async () => {
    const wrapper = mountForSession('session-ekko-verbs', [], undefined, ekko)
    await typeSlash(wrapper, '/')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    for (const verb of ['/context', '/compact', '/usage', '/status']) {
      expect(names).toContain(verb)
    }
  })

  it('recognises an ekko session identified only by codingAgentId', async () => {
    const wrapper = mountForSession('session-ekko-id-only', [
      { name: 'plan only', description: 'Plan and stop', enabled: true },
    ], undefined, { source: 'coding_agent', codingAgentId: 'ekko-agent' })
    await typeSlash(wrapper, '/plan')
    expect(wrapper.findAll('.slash-command-name').map(n => n.text())).toContain('/plan-only')
  })

  it('still does not offer skills to a non-ekko coding agent', async () => {
    const wrapper = mountForSession('session-codex', [
      { name: 'plan only', description: 'Plan and stop', enabled: true },
    ], undefined, { source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' })
    await typeSlash(wrapper, '/plan')
    const names = wrapper.findAll('.slash-command-name').map(n => n.text())
    expect(names).not.toContain('/plan-only')
  })
})
