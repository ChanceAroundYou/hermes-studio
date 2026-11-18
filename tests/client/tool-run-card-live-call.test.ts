// @vitest-environment jsdom
vi.hoisted(() => { (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = 'test' })
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('naive-ui')
  // 0.8.20 moved MessageList's toasts into useMessageSelection(), which calls
  // naive-ui's useMessage and throws without an <n-message-provider> ancestor.
  const toast = () => ({ content: '', duration: 0, icon: undefined, onClose: undefined, onFinished: undefined })
  const handle = () => ({ success: toast, error: toast, info: toast, warning: toast, loading: toast })
  return { ...actual, useMessage: handle, useDialog: handle }
})

// The virtual list only decides which rows are measured; the grouping question is
// about the array MessageList hands it, so render every row.
vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: { messages: { type: Array, default: () => [] } },
    emits: ['top-reach'],
    setup(_props, { expose }) {
      expose({
        isNearBottom: () => true,
        shouldAutoFollowBottom: () => true,
        scrollToBottom: vi.fn(),
        scrollToMessage: vi.fn(async () => true),
        scrollToAnchor: vi.fn(),
        cancelAnchorAlignment: vi.fn(),
        captureScrollPosition: vi.fn(),
        restoreScrollPosition: vi.fn(),
        captureViewportPosition: vi.fn(),
        restoreViewportPosition: vi.fn(),
      })
    },
    // before/after slots carry the history loader and the run indicator (which is
    // where the live tool strip renders), so the stub has to mount them or a
    // "no second box" assertion would pass against a component that was never
    // rendered.
    template: `
      <div class="virtual-message-list-stub">
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
    props: { message: { type: Object, required: true } },
    template: `<div class="stub-message" :data-id="message.id" :data-tool-status="message.toolStatus">{{ message.toolName || message.role }}</div>`,
  }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import ToolRunCard from '@/components/hermes/chat/ToolRunCard.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function tool(id: string, runMarker: string | undefined, toolStatus: Message['toolStatus']): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: `call-${id}`,
    toolStatus,
    runMarker,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
  } as Message
}

function makeSession(id: string, messages: Message[]): Session {
  return {
    id,
    title: id,
    profile: 'default',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Session
}

/** Tool ids inside a rendered ToolRunCard, independent of its collapsed state. */
function cardToolIds(wrapper: VueWrapper): string[] {
  const cards = wrapper.findAllComponents(ToolRunCard)
  expect(cards).toHaveLength(1)
  const tools = cards[0].props('tools') as unknown as Message[]
  expect(Array.isArray(tools)).toBe(true)
  return tools.map(tool => tool.id)
}

async function mountWith(messages: Message[]) {
  const chatStore = useChatStore()
  const session = makeSession('tool-card-session', messages)
  chatStore.sessions = [session]
  chatStore.activeSessionId = session.id
  chatStore.activeSession = session
  const wrapper = mount(MessageList, { global: { stubs: { Transition: false } } })
  await nextTick()
  await nextTick()
  return { wrapper, chatStore }
}

/**
 * The reported symptom: an in-flight call rendered as its own box *below* the
 * card that already lists the calls it settled into, and the card repainting
 * when the call finished. That is upstream's run-scoped rule (#2697), which
 * excludes `toolStatus === 'running'` from the card and hands those calls to a
 * separate live strip. A running call is the newest entry of the same card.
 */
describe('a running tool call joins the card above it', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('puts the in-flight call inside the trailing card while the run is live', async () => {
    // abortState is the store-reachable way to make the run read as live without
    // a socket, and it is exactly the state that used to hide the running row.
    const { wrapper, chatStore } = await mountWith([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1 } as Message,
      tool('t1', 'run-a', 'done'),
      tool('t2', 'run-a', 'running'),
    ])
    chatStore.abortState = { aborting: true, synced: null }
    await nextTick()

    // The card body is collapsed by default, so assert the list MessageList hands
    // the card: that list is what the dropdown renders when opened.
    expect(cardToolIds(wrapper)).toEqual(['t1', 't2'])
  })

  it('does not also render the live tool strip beside the card', async () => {
    const { wrapper, chatStore } = await mountWith([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1 } as Message,
      tool('t1', 'run-a', 'done'),
      tool('t2', 'run-a', 'running'),
    ])
    chatStore.abortState = { aborting: true, synced: null }
    await nextTick()

    const stripped = wrapper.findAll('.tool-calls-panel .tool-call-item')
      .filter(node => !node.classes().includes('compression-item'))
    expect(stripped.map(node => node.text())).toEqual([])
  })

  // The running call becomes the newest entry of the dropdown, not a visible second
  // box: the card is collapsed by default (ToolRunSummary expands only for an
  // `active` card), so opening it is what reveals the in-flight call.
  it('keeps the card collapsed so the in-flight call is a dropdown entry', async () => {
    const { wrapper, chatStore } = await mountWith([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1 } as Message,
      tool('t1', 'run-a', 'done'),
      tool('t2', 'run-a', 'running'),
    ])
    chatStore.abortState = { aborting: true, synced: null }
    await nextTick()

    const card = wrapper.findAllComponents(ToolRunCard)[0]
    const header = card.find('.tool-run-header')
    expect(header.exists()).toBe(true)
    expect(header.attributes('aria-expanded')).toBe('false')
    // Collapsed: the dropdown body is not mounted, yet the card already holds both calls.
    expect(card.find('.tool-run-items').exists()).toBe(false)
    expect(cardToolIds(wrapper)).toEqual(['t1', 't2'])

    // Opening the card is what surfaces the in-flight call, as a new entry of the
    // same dropdown rather than a second box on the page.
    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')
    const rows = card.findAll('.tool-run-items .stub-message').map(node => node.attributes('data-id'))
    expect(rows).toEqual(['t1', 't2'])
    expect(wrapper.findAll('.tool-run-card')).toHaveLength(1)
  })

  it('keeps the card content identical when the call settles, only the header changes', async () => {
    const { wrapper, chatStore } = await mountWith([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1 } as Message,
      tool('t1', 'run-a', 'done'),
      tool('t2', 'run-a', 'running'),
    ])
    chatStore.abortState = { aborting: true, synced: null }
    await nextTick()
    const liveRows = cardToolIds(wrapper)

    chatStore.abortState = null
    ;(useChatStore().activeSession as Session).messages[2] = tool('t2', 'run-a', 'done')
    await nextTick()
    const settledRows = cardToolIds(wrapper)

    expect(liveRows).toEqual(['t1', 't2'])
    expect(settledRows).toEqual(['t1', 't2'])
    expect(wrapper.findAllComponents(ToolRunCard)).toHaveLength(1)
  })
})
