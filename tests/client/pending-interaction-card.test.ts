// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import PendingInteractionCard from '@/components/hermes/chat/PendingInteractionCard.vue'

// `wrapper.emitted()` records nothing in this repo's vitest setup, so every
// expectation goes through real listener props instead.
function mountCard(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn()
  const onSubmit = vi.fn()
  const onDismiss = vi.fn()
  const wrapper = mount(PendingInteractionCard, {
    props: { question: 'Which environment?', onSelect, onSubmit, onDismiss, ...props },
  })
  return { wrapper, onSelect, onSubmit, onDismiss }
}

function buttonByText(wrapper: ReturnType<typeof mountCard>['wrapper'], text: string) {
  return wrapper.findAll('button').find(button => button.text() === text)
}

describe('PendingInteractionCard', () => {
  beforeEach(() => {
    window.innerWidth = 1024
  })

  it('answers with a single click on a choice and still offers every choice', async () => {
    const { wrapper, onSelect, onSubmit } = mountCard({ choices: ['staging', 'prod'] })

    expect(buttonByText(wrapper, 'staging')).toBeTruthy()
    expect(buttonByText(wrapper, 'prod')).toBeTruthy()

    await buttonByText(wrapper, 'prod')!.trigger('click')

    expect(onSelect).toHaveBeenCalledWith('prod')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('always offers Dismiss, with or without choices', async () => {
    const withChoices = mountCard({ choices: ['yes'] })
    expect(buttonByText(withChoices.wrapper, 'chat.clarifyDismiss')).toBeTruthy()
    await buttonByText(withChoices.wrapper, 'chat.clarifyDismiss')!.trigger('click')
    expect(withChoices.onDismiss).toHaveBeenCalledTimes(1)
    expect(withChoices.onSelect).not.toHaveBeenCalled()

    const withoutChoices = mountCard({ choices: null })
    expect(buttonByText(withoutChoices.wrapper, 'chat.clarifyDismiss')).toBeTruthy()
  })

  it('submits the trimmed answer on Enter for a desktop text input', async () => {
    const { wrapper, onSubmit } = mountCard({ modelValue: '  staging  ' })

    await wrapper.get('input').trigger('keydown', { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('staging')
  })

  it('keeps Enter as a plain newline on a phone so only the button answers', async () => {
    window.innerWidth = 640
    const { wrapper, onSubmit } = mountCard({ modelValue: 'staging' })

    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    await buttonByText(wrapper, 'chat.clarifySubmit')!.trigger('click')
    expect(onSubmit).toHaveBeenCalledWith('staging')
  })

  it('keeps Shift+Enter and editor Enter as newlines but answers on Ctrl/Cmd+Enter', async () => {
    const text = mountCard({ modelValue: 'staging' })
    await text.wrapper.get('input').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(text.onSubmit).not.toHaveBeenCalled()

    const editor = mountCard({ modelValue: 'multi line', responseMode: 'editor' })
    await editor.wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(editor.onSubmit).not.toHaveBeenCalled()

    await editor.wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(editor.onSubmit).toHaveBeenCalledWith('multi line')
  })

  it('blocks an empty answer but keeps editor mode available', () => {
    const empty = mountCard({ modelValue: '' })
    expect(buttonByText(empty.wrapper, 'chat.clarifySubmit')!.attributes('disabled')).toBeDefined()

    const filled = mountCard({ modelValue: 'staging' })
    expect(buttonByText(filled.wrapper, 'chat.clarifySubmit')!.attributes('disabled')).toBeUndefined()

    const editor = mountCard({ modelValue: '', responseMode: 'editor' })
    expect(buttonByText(editor.wrapper, 'chat.clarifySubmit')!.attributes('disabled')).toBeUndefined()
  })

  it('renders identical content under every host variant', () => {
    const inline = mountCard({ variant: 'inline' }).wrapper
    expect(inline.classes()).toContain('approval-float-panel')
    expect(inline.classes()).not.toContain('approval-float-panel--global')
    expect(inline.find('.float-panel-header').exists()).toBe(true)
    expect(inline.find('.approval-float-actions').exists()).toBe(true)
    expect(inline.find('.clarify-float-input-row').exists()).toBe(true)

    const portal = mountCard({ variant: 'portal' }).wrapper
    expect(portal.classes()).toContain('approval-float-panel')
    expect(portal.classes()).toContain('approval-float-panel--global')

    const notification = mountCard({ variant: 'notification' }).wrapper
    expect(notification.classes()).toContain('pending-interaction-card--notification')
    expect(notification.classes()).not.toContain('approval-float-panel')
    // The host notification already names the kind and the source in its header.
    expect(notification.find('.float-panel-header').exists()).toBe(false)
    expect(notification.find('.clarify-float-input-row').exists()).toBe(true)
  })

  it('names the asking agent in group rooms', () => {
    expect(mountCard({ agentName: 'Builder' }).wrapper.get('.approval-float-title').text()).toContain('@Builder')
    expect(mountCard({}).wrapper.get('.approval-float-title').text()).not.toContain('@')
  })
})
