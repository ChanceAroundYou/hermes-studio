// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('@/utils/clipboard', () => clipboard)

import PendingInteractionCard from '@/components/hermes/chat/PendingInteractionCard.vue'

// `wrapper.emitted()` records nothing in this repo's vitest setup, so every
// expectation goes through real listener props instead.
function mountCard(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn()
  const onSubmit = vi.fn()
  const onDismiss = vi.fn()
  const onCopyFailed = vi.fn()
  const wrapper = mount(PendingInteractionCard, {
    props: {
      question: 'Which environment?',
      onSelect,
      onSubmit,
      onDismiss,
      onCopyFailed,
      ...props,
    },
  })
  return { wrapper, onSelect, onSubmit, onDismiss, onCopyFailed }
}

function buttonByText(wrapper: ReturnType<typeof mountCard>['wrapper'], text: string) {
  return wrapper.findAll('button').find(button => button.text() === text)
}

function buttonLabels(wrapper: ReturnType<typeof mountCard>['wrapper']) {
  return wrapper.findAll('.approval-float-actions button').map(button => button.text())
}

describe('PendingInteractionCard', () => {
  beforeEach(() => {
    window.innerWidth = 1024
    clipboard.copyToClipboard.mockClear()
    clipboard.copyToClipboard.mockResolvedValue(true)
  })

  it('answers a clarification with a single click on a choice', async () => {
    const { wrapper, onSelect, onSubmit } = mountCard({ choices: ['staging', 'prod'] })

    expect(buttonByText(wrapper, 'staging')).toBeTruthy()
    await buttonByText(wrapper, 'prod')!.trigger('click')

    expect(onSelect).toHaveBeenCalledWith('prod')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('always offers Dismiss on a clarification, with or without choices', async () => {
    const withChoices = mountCard({ choices: ['yes'] })
    expect(buttonByText(withChoices.wrapper, 'chat.clarifyDismiss')).toBeTruthy()
    await buttonByText(withChoices.wrapper, 'chat.clarifyDismiss')!.trigger('click')
    expect(withChoices.onDismiss).toHaveBeenCalledTimes(1)
    expect(withChoices.onSelect).not.toHaveBeenCalled()

    expect(buttonByText(mountCard({ choices: null }).wrapper, 'chat.clarifyDismiss')).toBeTruthy()
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
    expect(buttonByText(mountCard({ modelValue: '' }).wrapper, 'chat.clarifySubmit')!.attributes('disabled')).toBeDefined()
    expect(buttonByText(mountCard({ modelValue: 'staging' }).wrapper, 'chat.clarifySubmit')!.attributes('disabled')).toBeUndefined()
    expect(buttonByText(
      mountCard({ modelValue: '', responseMode: 'editor' }).wrapper,
      'chat.clarifySubmit',
    )!.attributes('disabled')).toBeUndefined()
  })

  it('renders exactly the approval grants the server offered, in a stable order', async () => {
    const { wrapper, onSelect } = mountCard({
      kind: 'approval',
      question: null,
      description: 'Run tests',
      command: 'npm run test',
      approvalChoices: ['deny', 'always', 'session', 'once'],
    })

    // The group chat used to drop `session`; one card means every host offers it.
    expect(buttonLabels(wrapper)).toEqual([
      'chat.approvalAllowOnce',
      'chat.approvalAllowSession',
      'chat.approvalAlways',
      'chat.approvalDeny',
    ])
    // Approvals never render the clarification free-text row.
    expect(wrapper.find('.clarify-float-input-row').exists()).toBe(false)

    await buttonByText(wrapper, 'chat.approvalAllowSession')!.trigger('click')
    expect(onSelect).toHaveBeenCalledWith('session')
  })

  it('turns a memory-write approval into agree/deny only', () => {
    const { wrapper } = mountCard({
      kind: 'approval',
      question: null,
      description: 'Remember this',
      command: 'memory write',
      approvalChoices: ['deny', 'always', 'session', 'once'],
      isMemoryWrite: true,
    })

    expect(buttonLabels(wrapper)).toEqual(['chat.approvalAgree', 'chat.approvalDeny'])
    expect(buttonByText(wrapper, 'chat.clarifyDismiss')).toBeUndefined()
  })

  it('renders custom actions with their own labels, tone and loading state', async () => {
    const actions = [
      { key: 'approve', label: 'groupChat.approveAgent', variant: 'primary' as const, loading: true },
      { key: 'reject', label: 'groupChat.rejectAgent', variant: 'error' as const, disabled: true },
    ]
    const { wrapper, onSelect } = mountCard({ kind: 'custom', question: null, actions })

    expect(buttonLabels(wrapper)).toEqual(['groupChat.approveAgent', 'groupChat.rejectAgent'])
    await buttonByText(wrapper, 'groupChat.rejectAgent')!.trigger('click')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('previews the command with a copy button and reports a failed copy', async () => {
    const { wrapper, onCopyFailed } = mountCard({
      kind: 'approval',
      question: null,
      description: 'Security scan',
      command: 'rm -rf /tmp/x &&\nmkdir -p /tmp/x',
      approvalChoices: ['once', 'deny'],
    })

    const preview = wrapper.get('.approval-float-command')
    expect(preview.get('.approval-float-command-label').text()).toBe('chat.approvalCommand')
    expect(preview.get('pre > code').text()).toBe('rm -rf /tmp/x &&\nmkdir -p /tmp/x')
    expect(preview.get('pre').attributes('tabindex')).toBe('0')

    await preview.get('button').trigger('click')
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith('rm -rf /tmp/x &&\nmkdir -p /tmp/x')
    expect(preview.get('button').text()).toBe('common.copied')

    clipboard.copyToClipboard.mockResolvedValueOnce(false)
    await preview.get('button').trigger('click')
    expect(onCopyFailed).toHaveBeenCalledTimes(1)
    expect(preview.get('button').text()).toBe('chat.copyFailed')
  })

  it('renders identical content under every host variant', () => {
    const inline = mountCard({ kind: 'approval', question: null, approvalChoices: ['once'] }).wrapper
    expect(inline.classes()).toContain('approval-float-panel')
    expect(inline.classes()).not.toContain('approval-float-panel--global')
    expect(inline.find('.float-panel-header').exists()).toBe(true)
    expect(inline.find('.approval-float-actions').exists()).toBe(true)

    const portal = mountCard({ variant: 'portal' }).wrapper
    expect(portal.classes()).toContain('approval-float-panel')
    expect(portal.classes()).toContain('approval-float-panel--global')

    const notification = mountCard({ variant: 'notification' }).wrapper
    expect(notification.classes()).toContain('pending-interaction-card--notification')
    expect(notification.classes()).not.toContain('approval-float-panel')
    // The host notification already names the kind and the source in its header.
    expect(notification.find('.float-panel-header').exists()).toBe(false)
    expect(notification.find('.approval-float-title').exists()).toBe(false)
    expect(notification.find('.clarify-float-input-row').exists()).toBe(true)
  })

  it('names the asking agent in group rooms and lets a custom host set its own title', () => {
    const prefixed = mountCard({ titlePrefix: 'Builder' }).wrapper
    expect(prefixed.get('.approval-float-title').text()).toBe('@Builder · chat.clarifyTitle')
    expect(mountCard({}).wrapper.get('.approval-float-title').text()).toBe('chat.clarifyTitle')

    const custom = mountCard({ kind: 'custom', title: '@Builder', question: null, actions: [] }).wrapper
    expect(custom.get('.approval-float-title').text()).toBe('@Builder')
    expect(custom.get('.float-panel-header').text()).toContain('')
  })
})
