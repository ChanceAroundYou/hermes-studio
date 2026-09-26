// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fetchSkillBundlesMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: {
    props: ['options'],
    emits: ['select'],
    template: '<div class="dropdown-stub"><button v-for="option in options" :key="option.key" class="dropdown-option">{{ option.label }}</button><slot /></div>',
  },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSlider: { template: '<input class="n-slider-stub" type="range" />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionPushEnabled: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/studio/social-messages', () => ({
  fetchSocialMessagePlatforms: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: fetchSkillBundlesMock,
  deleteSkillBundleApi: vi.fn(),
}))

vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: { name: 'BundleCreateModal', template: '<div />' },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

function mountComposer(sessionId: string) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now() },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  settingsStore.display = {}
  const sendSpy = vi.spyOn(chatStore, 'sendMessage').mockResolvedValue(undefined as never)
  const wrapper = mount(ChatInput, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, sendSpy }
}

/** The soft line break a mobile virtual keyboard would insert. */
function dispatchLineBreak(textarea: HTMLTextAreaElement) {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true }) as Event & { inputType?: string }
  event.inputType = 'insertLineBreak'
  textarea.dispatchEvent(event)
  return event
}

function dispatchEnterKeydown(
  textarea: HTMLTextAreaElement,
  options: { composing?: boolean; shift?: boolean } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: options.shift === true,
    bubbles: true,
    cancelable: true,
  })
  if (options.composing) {
    Object.defineProperty(event, 'isComposing', { value: true })
  }
  textarea.dispatchEvent(event)
  return event
}

/**
 * On a phone the virtual keyboard's confirm / return keys must always insert a
 * newline; only the arrow send button at the bottom-right of the composer may
 * send. Desktop keeps Enter-to-send, so every case below pins both viewports.
 */
describe('ChatInput mobile confirm key', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
  })

  it('inserts a newline instead of sending when Enter is pressed on a phone', async () => {
    window.innerWidth = 390
    const { wrapper, sendSpy } = mountComposer('session-mobile-enter')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    await wrapper.find('textarea').setValue('first line')

    const event = dispatchEnterKeydown(textarea)

    expect(event.defaultPrevented).toBe(false)
    expect(sendSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not send on a composing Enter from a phone IME', async () => {
    window.innerWidth = 390
    const { wrapper, sendSpy } = mountComposer('session-mobile-composing')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    await wrapper.find('textarea').setValue('拼写中')

    const event = dispatchEnterKeydown(textarea, { composing: true })

    expect(event.defaultPrevented).toBe(false)
    expect(sendSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('leaves the IME soft line break alone on a phone', async () => {
    window.innerWidth = 390
    const { wrapper, sendSpy } = mountComposer('session-mobile-linebreak')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    await wrapper.find('textarea').setValue('multi line')

    const event = dispatchLineBreak(textarea)

    expect(event.defaultPrevented).toBe(false)
    expect(sendSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sends on a phone only through the arrow send button', async () => {
    window.innerWidth = 390
    const { wrapper, sendSpy } = mountComposer('session-mobile-button')
    await wrapper.find('textarea').setValue('tap to send')

    await wrapper.find('.send-button').trigger('click')

    expect(sendSpy).toHaveBeenCalledWith('tap to send', undefined)
    wrapper.unmount()
  })

  it('keeps Enter-to-send on a desktop viewport', async () => {
    window.innerWidth = 1024
    const { wrapper, sendSpy } = mountComposer('session-desktop-enter')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    await wrapper.find('textarea').setValue('desktop enter')

    const event = dispatchEnterKeydown(textarea)

    expect(event.defaultPrevented).toBe(true)
    expect(sendSpy).toHaveBeenCalledWith('desktop enter', undefined)
    wrapper.unmount()
  })

  it('keeps Shift+Enter as a newline on a desktop viewport', async () => {
    window.innerWidth = 1024
    const { wrapper, sendSpy } = mountComposer('session-desktop-shift-enter')
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    await wrapper.find('textarea').setValue('desktop newline')

    const event = dispatchEnterKeydown(textarea, { shift: true })

    expect(event.defaultPrevented).toBe(false)
    expect(sendSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
