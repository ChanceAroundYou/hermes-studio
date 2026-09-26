// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const codex = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }))
const nous = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }))
const xai = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }))
const anthropic = vi.hoisted(() => ({ start: vi.fn(), submit: vi.fn() }))
const minimax = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }))
const message = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))

vi.mock('@/api/hermes/codex-auth', () => ({ startCodexLogin: codex.start, pollCodexLogin: codex.poll }))
vi.mock('@/api/hermes/nous-auth', () => ({ startNousLogin: nous.start, pollNousLogin: nous.poll }))
vi.mock('@/api/hermes/xai-auth', () => ({ startXaiLogin: xai.start, pollXaiLogin: xai.poll }))
vi.mock('@/api/hermes/anthropic-auth', () => ({
  startAnthropicLogin: anthropic.start,
  submitAnthropicLogin: anthropic.submit,
}))
vi.mock('@/api/hermes/minimax-auth', () => ({ startMiniMaxLogin: minimax.start, pollMiniMaxLogin: minimax.poll }))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  // `emits` matters: without it Vue also attaches the parent's @click as a native
  // listener on the mock's root button, and the handler runs twice.
  NButton: { emits: ['click'], template: '<button type="button" @click="$emit(\'click\')"><slot /></button>' },
  NSpin: { template: '<span class="spin" />' },
  NInput: {
    props: ['value'],
    emits: ['update:value'],
    template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  },
  NRadioGroup: { props: ['value'], template: '<div><slot /></div>' },
  NRadioButton: { props: ['value'], template: '<button><slot /></button>' },
  useMessage: () => message,
}))

import AnthropicLoginModal from '@/components/hermes/models/AnthropicLoginModal.vue'
import CodexLoginModal from '@/components/hermes/models/CodexLoginModal.vue'
import MiniMaxOAuthLoginModal from '@/components/hermes/models/MiniMaxOAuthLoginModal.vue'
import NousLoginModal from '@/components/hermes/models/NousLoginModal.vue'
import XaiOAuthLoginModal from '@/components/hermes/models/XaiOAuthLoginModal.vue'

interface Provider {
  name: string
  component: typeof CodexLoginModal
  start: ReturnType<typeof vi.fn>
  intervalMs: number
  /** The code the start call hands back, or '' for a link-only provider. */
  code: string
}

const providers: Provider[] = [
  { name: 'codex', component: CodexLoginModal, start: codex.start, intervalMs: 3_000, code: 'ABCD-1234' },
  { name: 'nous', component: NousLoginModal, start: nous.start, intervalMs: 3_000, code: 'NOUS-5678' },
  { name: 'xai', component: XaiOAuthLoginModal, start: xai.start, intervalMs: 2_000, code: '' },
  { name: 'minimax', component: MiniMaxOAuthLoginModal, start: minimax.start, intervalMs: 2_000, code: 'MM-0001' },
]

/** The shell renders the provider's buttons plus a footer cancel, so find by label. */
function buttonByLabel(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find(button => button.text().includes(label))
  if (!found) throw new Error(`no button labelled ${label}: ${wrapper.text()}`)
  return found
}

function startPayload(provider: Provider) {
  return provider.code
    ? { session_id: 'sess', user_code: provider.code, verification_url: 'https://example.test/device' }
    : { session_id: 'sess', authorization_url: 'https://example.test/auth' }
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of [codex.start, codex.poll, nous.start, nous.poll, xai.start, xai.poll,
    anthropic.start, anthropic.submit, minimax.start, minimax.poll]) {
    fn.mockReset()
  }
  message.success.mockReset()
  message.error.mockReset()
  window.open = vi.fn()
})

describe.each(providers)('$name login modal', provider => {
  it('starts the provider flow and shows what the user must do', async () => {
    provider.start.mockResolvedValue(startPayload(provider))
    const wrapper = mount(provider.component)
    await flushPromises()

    if (provider.name === 'minimax') {
      // This provider only starts once the user picks a region and confirms.
      expect(provider.start).not.toHaveBeenCalled()
      await buttonByLabel(wrapper, 'models.minimaxStart').trigger('click')
      await flushPromises()
    }

    expect(provider.start).toHaveBeenCalledTimes(1)
    const text = wrapper.text()
    if (provider.code) expect(text).toContain(provider.code)
    else expect(text).toContain('models.xaiWaiting')
    // The waiting state can be left behind by the cancel button.
    expect(wrapper.text()).not.toContain('models.copilotDenied')
    wrapper.unmount()
  })

  it('reports approval once the poll says so, and emits success after the fades', async () => {
    provider.start.mockResolvedValue(startPayload(provider))
    ;(provider.name === 'minimax' ? minimax.poll : provider.name === 'nous' ? nous.poll : provider.name === 'xai' ? xai.poll : codex.poll)
      .mockResolvedValue({ status: 'approved', error: null })

    const onSuccess = vi.fn()
    const wrapper = mount(provider.component, { props: { onSuccess } as never })
    await flushPromises()

    if (provider.name === 'minimax') {
      await buttonByLabel(wrapper, 'models.minimaxStart').trigger('click')
      await flushPromises()
    }

    await vi.advanceTimersByTimeAsync(provider.intervalMs)
    await flushPromises()
    expect(message.success).toHaveBeenCalledWith(`models.${provider.name === 'minimax' ? 'minimaxApproved' : `${provider.name}Approved`}`)

    await vi.advanceTimersByTimeAsync(1_300)
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(onSuccess).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows the expired state without emitting success', async () => {
    provider.start.mockResolvedValue(startPayload(provider))
    const poll = provider.name === 'minimax' ? minimax.poll : provider.name === 'nous' ? nous.poll : provider.name === 'xai' ? xai.poll : codex.poll
    poll.mockResolvedValue({ status: 'expired', error: null })

    const wrapper = mount(provider.component)
    await flushPromises()
    if (provider.name === 'minimax') {
      await buttonByLabel(wrapper, 'models.minimaxStart').trigger('click')
      await flushPromises()
    }
    await vi.advanceTimersByTimeAsync(provider.intervalMs)
    await flushPromises()

    expect(wrapper.text()).toContain(`models.${provider.name === 'minimax' ? 'minimaxExpired' : `${provider.name}Expired`}`)
    expect(wrapper.emitted('success')).toBeFalsy()
    wrapper.unmount()
  })

  it('toasts a failed start and stays open', async () => {
    provider.start.mockRejectedValue(new Error('boom'))
    const wrapper = mount(provider.component)
    await flushPromises()

    if (provider.name === 'minimax') {
      await buttonByLabel(wrapper, 'models.minimaxStart').trigger('click')
      await flushPromises()
    }

    expect(message.error).toHaveBeenCalled()
    expect(wrapper.emitted('success')).toBeFalsy()
    wrapper.unmount()
  })
})

describe('nous login modal', () => {
  it('treats a denied poll as an error state', async () => {
    nous.start.mockResolvedValue({ session_id: 'sess', user_code: 'NOUS-1', verification_url: 'https://example.test' })
    nous.poll.mockResolvedValue({ status: 'denied', error: null })

    const wrapper = mount(NousLoginModal)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()

    expect(wrapper.text()).toContain('models.nousDenied')
    wrapper.unmount()
  })
})

describe('anthropic login modal', () => {
  it('waits for a pasted code and approves it', async () => {
    anthropic.start.mockResolvedValue({ session_id: 'sess', authorization_url: 'https://example.test/auth' })
    anthropic.submit.mockResolvedValue({ status: 'approved', error: null })

    const onSuccess = vi.fn()
    const wrapper = mount(AnthropicLoginModal, { props: { onSuccess } as never })
    await flushPromises()

    // No polling: this provider waits for the user to paste the code back.
    expect(anthropic.submit).not.toHaveBeenCalled()
    await wrapper.find('textarea').setValue('pasted-code')
    await buttonByLabel(wrapper, 'models.anthropicSubmitCode').trigger('click')
    await flushPromises()

    expect(anthropic.submit).toHaveBeenCalledWith('sess', 'pasted-code')
    expect(message.success).toHaveBeenCalledWith('models.anthropicApproved')

    await vi.advanceTimersByTimeAsync(1_300)
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(onSuccess).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('renders a rejected code as an error state', async () => {
    anthropic.start.mockResolvedValue({ session_id: 'sess', authorization_url: 'https://example.test/auth' })
    anthropic.submit.mockResolvedValue({ status: 'error', error: 'bad code' })

    const wrapper = mount(AnthropicLoginModal)
    await flushPromises()
    await wrapper.find('textarea').setValue('nope')
    await buttonByLabel(wrapper, 'models.anthropicSubmitCode').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('bad code')
    wrapper.unmount()
  })
})
