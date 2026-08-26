// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
      virtualized: { type: Boolean, default: true },
    },
    setup(_props, { expose }) {
      expose({
        isNearBottom: () => true,
        shouldAutoFollowBottom: () => true,
        scrollToBottom: vi.fn(),
        scrollToMessage: vi.fn(),
        scrollToAnchor: vi.fn(),
        captureScrollPosition: () => null,
        restoreScrollPosition: vi.fn(),
        captureViewportPosition: () => null,
        restoreViewportPosition: vi.fn(),
      })
    },
    template: `
      <div class="virtual-message-list-stub">
        <slot name="empty" />
        <slot name="before" />
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
        <slot name="after" />
      </div>
    `,
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({
    name: 'MessageItem',
    props: {
      message: { type: Object, required: true },
      highlight: { type: Boolean, default: false },
    },
    template: '<div class="stub-message" :data-role="message.role" :data-id="message.id">{{ message.toolName || message.content }}</div>',
  }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-1',
    title: 'Tool trace visibility',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const sampleMessages: Message[] = [
  { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
  { id: 'tool-named', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolResult: 'ok', toolStatus: 'done' },
  { id: 'tool-internal', role: 'tool', content: '', timestamp: 3, toolResult: 'internal', toolStatus: 'done' },
  { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 4 },
]

describe('tool trace visibility', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('hermes_show_tool_calls')
    useToolTraceVisibility().setToolTraceVisible(true)
  })

  function mountLiveList() {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession(sampleMessages)
    chatStore.abortState = { aborting: true, synced: false }

    return mount(MessageList, {})
  }

  it('shows named transcript and live tool traces by default while keeping unnamed internal tools hidden', () => {
    const wrapper = mountLiveList()

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'tool-named',
      'assistant-1',
    ])
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')
  })

  it('applies the same default-visible rule to history sessions', () => {
    const wrapper = mount(HistoryMessageList, {
      props: { session: makeSession(sampleMessages) },
    })

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'tool-named',
      'assistant-1',
    ])
  })

  it('does not fall back to the live chat session while history session data is loading', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession(sampleMessages)

    const wrapper = mount(HistoryMessageList, {})

    expect(wrapper.findAll('.stub-message')).toHaveLength(0)
  })

  it('hides named transcript traces when the toggle is off while keeping live tool stream visible', () => {
    useToolTraceVisibility().setToolTraceVisible(false)

    const liveWrapper = mountLiveList()
    expect(liveWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
    expect(liveWrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')

    const historyWrapper = mount(HistoryMessageList, {
      props: { session: makeSession(sampleMessages) },
    })
    expect(historyWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
  })

  it('does not treat tool traces before a slash command as current tool calls', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      { id: 'user-1', role: 'user', content: 'check weather', timestamp: 1 },
      { id: 'tool-weather', role: 'tool', content: '', timestamp: 2, toolName: 'weather', toolResult: 'ok', toolStatus: 'done' },
      { id: 'command-1', role: 'command', content: '/moa where next', timestamp: 3 },
    ])
    chatStore.abortState = { aborting: true, synced: false }

    const wrapper = mount(MessageList, {})

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toContain('tool-weather')
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).not.toContain('weather')
  })

})
