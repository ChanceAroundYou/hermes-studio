// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

/**
 * One bubble for anything the reader has to act on.
 *
 * An agent notice -- "⏳ Another Hermes process is using this session; waiting
 * for it to finish before starting your turn..." -- is not a failure, but it is
 * the same kind of thing to read: something is wrong with this turn and you have
 * to do something about it. It rendered in a third style, an amber left-striped
 * bubble, which a comment in the source described as retired while the class was
 * still being applied.
 *
 * The class decision is asserted by rendering, because the wiring guard next door
 * only proves the expression is written down; this proves the expression is what
 * the message actually gets.
 */

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  NButton: { template: '<button><slot /></button>' },
  NButtonGroup: { template: '<div><slot /></div>' },
  NTooltip: { template: '<div><slot /></div>' },
  NPopover: { template: '<div><slot /><slot name="trigger" /></div>' },
  NTag: { template: '<span><slot /></span>' },
  NSwitch: { template: '<input type="checkbox" />' },
}))
vi.mock('@/api/studio/download', () => ({
  downloadFile: vi.fn(),
  getDownloadUrl: (_p: string, name: string) => `/download/${name}`,
}))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('@/composables/useSpeech', () => ({
  useGlobalSpeech: () => ({
    isSupported: ref(false),
    availableVoices: ref([]),
    isPlaying: ref(false),
    isPaused: ref(false),
    isCustomPlaying: ref(false),
    isCustomPaused: ref(false),
    currentMessageId: ref(null),
    currentCustomMessageId: ref(null),
    progress: ref(0),
    engine: ref(''),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    openaiToggle: vi.fn(),
    mimoToggle: vi.fn(),
    customToggle: vi.fn(),
    edgeToggle: vi.fn(),
    doubaoToggle: vi.fn(),
  }),
}))
vi.mock('@/utils/ttsHelpers', () => ({
  speedToEdgeRate: (v: number) => v,
  hzToEdgePitch: (v: number) => v,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({
    display: {
      show_reasoning: false,
      show_tool_details: false,
      notify_on_approval: false,
      approval_sound_enabled: false,
    },
  }),
}))
vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => ({ closePreview: vi.fn() }),
  getLanguageFromPath: () => 'text',
}))
vi.mock('@/stores/hermes/tool-panel', () => ({
  useToolPanelStore: () => ({ openWorkspaceDiff: vi.fn(async () => undefined) }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

function mountMessage(message: Partial<Message>) {
  setActivePinia(createPinia())
  return mount(MessageItem, {
    props: {
      message: { id: 'm1', role: 'system', content: 'notice', timestamp: 0, ...message } as Message,
    },
    global: { stubs: { RunUsageCard: true, TaskPlanCard: true, ToolChangeCard: true, ToolRunCard: true } },
  })
}

describe('two shapes for what the agent says mid-run', () => {
  it('gives progress the neutral card, not the error colour', () => {
    // The agent narrating its own maintenance. Nothing is wrong and nothing is
    // asked of the reader, so this must not look like a failure.
    const wrapper = mountMessage({
      role: 'system',
      content: '📦 Preflight compression: ~120,000 tokens >= 100,000 threshold. This may take a moment.',
      commandAction: 'agent.event',
    })
    const bubble = wrapper.find('.message-bubble')
    expect(bubble.exists()).toBe(true)
    expect(bubble.classes()).toContain('notice')
    expect(bubble.classes()).not.toContain('agent-error')
    // And the third style is gone for good.
    expect(bubble.classes()).not.toContain('system')
  })

  it('gives a blocked wait the error bubble', () => {
    // The reported case, verbatim. The store routes it to the error row, so it
    // arrives here tagged -- waiting on another process is something the reader
    // has to act on, not progress.
    const wrapper = mountMessage({
      role: 'system',
      content: '⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn...',
      systemType: 'error',
    })
    const bubble = wrapper.find('.message-bubble')
    expect(bubble.classes()).toContain('agent-error')
    expect(bubble.classes()).not.toContain('notice')
  })

  it('gives a system error the same bubble', () => {
    const wrapper = mountMessage({
      role: 'system',
      content: 'Error: something failed',
      systemType: 'error',
    })
    expect(wrapper.find('.message-bubble').classes()).toContain('agent-error')
  })

  it('leaves a settled compression out of it', () => {
    // A compression is a fact, not something to act on: it keeps the rounded
    // command treatment.
    const wrapper = mountMessage({
      role: 'system',
      content: 'Context compressed',
      systemType: 'compression',
      compression: { startedAt: 1, status: 'done' } as any,
    })
    const bubble = wrapper.find('.message-bubble')
    expect(bubble.classes()).toContain('compression')
    expect(bubble.classes()).not.toContain('agent-error')
  })

  it('leaves structural entries out of it', () => {
    // A fork divider and a tool run are structure, not notices. They carry a
    // `systemType`, which is exactly what the notice test keys off.
    for (const systemType of ['fork-divider', 'tool-run'] as const) {
      const wrapper = mountMessage({ role: 'system', content: 'x', systemType })
      expect(wrapper.find('.message-bubble').classes()).not.toContain('agent-error')
    }
  })

  it('leaves ordinary replies alone', () => {
    const wrapper = mountMessage({ role: 'assistant', content: 'Error handling in the parser looks correct' })
    const bubble = wrapper.find('.message-bubble')
    expect(bubble.classes()).not.toContain('agent-error')
    expect(bubble.classes()).not.toContain('system')
  })
})
