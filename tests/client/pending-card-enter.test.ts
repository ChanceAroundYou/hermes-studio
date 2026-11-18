// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent } from 'vue'

const mobile = vi.hoisted(() => ({ value: false }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/useMediaQuery', () => ({
  useMobileLayout: () => computed(() => mobile.value),
}))
vi.mock('@/components/hermes/chat/PendingInteractionCountdown.vue', () => ({
  default: defineComponent({ name: 'Countdown', template: '<span />' }),
}))

import PendingInteractionCard from '@/components/hermes/chat/PendingInteractionCard.vue'

/**
 * GroupChatPanel mounts the shared card exactly like this: no `kind` override
 * (so it defaults to clarify), `v-model` for the answer, and the response mode
 * the server chose. Upstream kept its own Enter handler inside GroupChatPanel;
 * the card has to answer for every host, otherwise Enter does nothing there.
 *
 * naive-ui is deliberately unmocked. A stubbed NInput does not forward
 * `keydown` to the card, which reports a working affordance as broken.
 */
function mountClarify(props: Record<string, unknown> = {}) {
  const answered = vi.fn()
  const wrapper = mount(PendingInteractionCard, {
    props: { modelValue: '用 /data 目录', responseMode: 'input', onSubmit: answered, ...props },
  })
  return { wrapper, answered }
}

async function pressEnter(wrapper: ReturnType<typeof mountClarify>['wrapper'], extra: Record<string, boolean> = {}) {
  const field = wrapper.find('input, textarea')
  expect(field.exists()).toBe(true)
  field.element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...extra }),
  )
  // naive-ui routes the key through its own input state before the host
  // handler runs, so the answer lands on a later tick. Reading it synchronously
  // reports nothing and looks like a broken affordance.
  for (let tick = 0; tick < 10; tick++) {
    await wrapper.vm.$nextTick()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('Enter answers a clarify prompt on every host that mounts the card', () => {
  it('submits a typed answer', async () => {
    const { wrapper, answered } = mountClarify()
    await pressEnter(wrapper)
    // The card declares `submit` and every host mounts it with an `onSubmit`
    // listener, so the observable contract is that the listener received the
    // answer. `wrapper.emitted()` cannot see a listener passed as an attr.
    expect(answered).toHaveBeenCalledTimes(1)
    expect(answered).toHaveBeenCalledWith('用 /data 目录')
  })

  it('answers with Ctrl+Enter in editor mode', async () => {
    const { wrapper, answered } = mountClarify({ responseMode: 'editor', modelValue: '两行\n回答' })
    await pressEnter(wrapper, { ctrlKey: true })
    expect(answered).toHaveBeenCalledWith('两行\n回答')
  })

  it('answers with Cmd+Enter in editor mode', async () => {
    const { wrapper, answered } = mountClarify({ responseMode: 'editor', modelValue: '回答' })
    await pressEnter(wrapper, { metaKey: true })
    expect(answered).toHaveBeenCalledWith('回答')
  })

  it('leaves plain Enter to the editor textarea, as upstream did', async () => {
    // Upstream's own handler bailed out for `responseMode === 'editor'` so a
    // multi-line answer could still be written.
    const { wrapper, answered } = mountClarify({ responseMode: 'editor', modelValue: '第一行' })
    await pressEnter(wrapper)
    expect(answered).not.toHaveBeenCalled()
  })

  it('keeps Shift+Enter as a line break', async () => {
    const { wrapper, answered } = mountClarify()
    await pressEnter(wrapper, { shiftKey: true })
    expect(answered).not.toHaveBeenCalled()
  })

  it('does not answer an empty answer, matching the disabled send button', async () => {
    const { wrapper, answered } = mountClarify({ modelValue: '   ' })
    await pressEnter(wrapper)
    expect(answered).not.toHaveBeenCalled()
  })

  it('ignores Enter on a phone-sized viewport, where the key is a line break', async () => {
    mobile.value = true
    try {
      const { wrapper, answered } = mountClarify()
      await pressEnter(wrapper)
      expect(answered).not.toHaveBeenCalled()
    } finally {
      mobile.value = false
    }
  })

  it('does not answer twice while a submission is in flight', async () => {
    const { wrapper, answered } = mountClarify({ submitting: true })
    await pressEnter(wrapper)
    expect(answered).not.toHaveBeenCalled()
  })
})
