// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  fetchAgentStatusSnapshot: vi.fn(),
  checkCodingAgentUpdate: vi.fn(),
  deleteCodingAgent: vi.fn(),
  fetchCodingAgentsStatus: vi.fn(),
  installCodingAgent: vi.fn(),
  readCodingAgentConfigFile: vi.fn(),
  writeCodingAgentConfigFile: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))



vi.mock('@/api/hermes/system', () => ({
  fetchAvailableModelsForProfile: vi.fn().mockResolvedValue({ groups: [] }),
}))

vi.mock('@/api/agent-status', () => ({
  fetchAgentStatusSnapshot: apiMocks.fetchAgentStatusSnapshot,
}))

vi.mock('@/api/hermes/runtime-versions', () => ({
  fetchRuntimeVersionStatus: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/hermes/legacy-data-migration', () => ({
  decideLegacyWindowsDataMigration: vi.fn(),
  fetchLegacyWindowsDataMigrationStatus: vi.fn(),
}))

vi.mock('@/api/coding-agents', () => ({
  ...apiMocks,
  inferCodingAgentApiMode: () => 'codex_responses',
  launchCodingAgentNativeTerminal: vi.fn(),
  normalizeCodingAgentApiMode: (value?: string, fallback?: string) => value || fallback || 'codex_responses',
  prepareCodingAgentLaunch: vi.fn(),
  getAgentUpdatePolicies: vi.fn().mockResolvedValue({ agents: {} }),
  setAgentAutoUpdate: vi.fn().mockResolvedValue({ agents: {} }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ serverVersion: '0.7.0', setPageSidebarExpanded: vi.fn() }),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({ newChat: vi.fn() }),
}))

vi.mock('@/api/client', () => ({
  getBaseUrlValue: () => '',
}))

vi.mock('@/utils/desktop-bridge', () => ({
  desktopBridge: vi.fn(() => undefined),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default' }),
}))

vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  default: defineComponent({ template: '<div />' }),
}))

const routeMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  query: {} as Record<string, string>,
}))

let routeState = routeMock

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => {
  const SlotStub = defineComponent({ template: '<div><slot /></div>' })
  return {
    NAlert: SlotStub,
    NButton: defineComponent({
      props: { disabled: Boolean, loading: Boolean },
      emits: ['click'],
      template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
    }),
    NForm: SlotStub,
    NFormItem: SlotStub,
    NInput: defineComponent({ props: ['value', 'type', 'placeholder', 'disabled'], template: '<textarea :placeholder="placeholder" />', }),
    NModal: SlotStub,
    NRadioButton: SlotStub,
    NRadioGroup: SlotStub,
    NSelect: SlotStub,
    NSpace: SlotStub,
    NSpin: SlotStub,
    NTag: defineComponent({ template: '<span><slot /></span>' }),
    NPopconfirm: defineComponent({ template: '<div><slot name="trigger" /><slot /></div>' }),
    NSwitch: defineComponent({ template: '<div />' }),
    NDrawer: defineComponent({ template: '<div><slot /></div>' }),
    NDrawerContent: defineComponent({ template: '<div><slot /></div>' }),
    useMessage: () => messageMock,
    useDialog: () => ({ warning: vi.fn() }),
  }
})

import AgentManagerView from '@/views/hermes/AgentManagerView.vue'

const claudeV1 = {
  id: 'claude-code',
  name: 'Claude Code',
  provider: 'Anthropic',
  command: 'claude',
  packageName: '@anthropic-ai/claude-code',
  installed: true,
  version: '1.0.0',
  rawVersion: '1.0.0',
}

const claudeV2 = {
  ...claudeV1,
  version: '2.0.0',
  rawVersion: '2.0.0',
}

const codexMissing = {
  id: 'codex',
  name: 'Codex',
  provider: 'OpenAI',
  command: 'codex',
  packageName: '@openai/codex',
  installed: false,
  version: '',
  rawVersion: '',
}

function buttonWithText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find(button => button.text() === text)
}

describe('AgentManagerView update state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchAgentStatusSnapshot.mockResolvedValue({
      agents: [claudeV1, codexMissing].map(tool => ({
        id: tool.id,
        installed: tool.installed,
        version: tool.version,
        source: 'user-cli',
      })),
    })
    apiMocks.fetchCodingAgentsStatus.mockResolvedValue({ tools: [claudeV1, codexMissing] })
    apiMocks.readCodingAgentConfigFile.mockResolvedValue({
      content: '',
      absolutePath: '/tmp/config',
      exists: false,
    })
  })

  it('replaces the stale update button after an update completes', async () => {
    apiMocks.checkCodingAgentUpdate
      .mockResolvedValueOnce({
        success: true,
        tool: claudeV1,
        latestVersion: '2.0.0',
        updateAvailable: true,
      })
    apiMocks.installCodingAgent.mockResolvedValue({
      success: true,
      tool: claudeV2,
      tools: [claudeV2, codexMissing],
    })

    const wrapper = mount(AgentManagerView)
    await flushPromises()

    await buttonWithText(wrapper, 'codingAgents.checkUpdate')!.trigger('click')
    await flushPromises()

    const card = wrapper.get('[data-testid="agent-card-claude-code"]')
    const updateButton = buttonWithText(card, 'agentManager.updateToVersion')
    expect(updateButton).toBeTruthy()

    await updateButton!.trigger('click')
    await flushPromises()

    expect(apiMocks.installCodingAgent).toHaveBeenCalledWith('claude-code')
    expect(wrapper.get('[data-testid="agent-card-claude-code"]').text()).toContain('2.0.0')
    expect(buttonWithText(wrapper, 'agentManager.updateToVersion')).toBeFalsy()
    expect(buttonWithText(wrapper, 'codingAgents.checkUpdate')).toBeTruthy()
  })

  it('shows only the error toast when the update check fails', async () => {
    apiMocks.checkCodingAgentUpdate.mockResolvedValue({
      success: false,
      tool: claudeV1,
      latestVersion: '',
      updateAvailable: false,
      message: 'registry unavailable',
    })

    const wrapper = mount(AgentManagerView)
    await flushPromises()

    await buttonWithText(wrapper, 'codingAgents.checkUpdate')!.trigger('click')
    await flushPromises()

    expect(messageMock.error).toHaveBeenCalledWith('registry unavailable')
    expect(wrapper.find('[data-testid="coding-agent-update-claude-code"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('codingAgents.upToDate')
    expect(wrapper.text()).not.toContain('codingAgents.checkingUpdate')
  })

  it('shows Pi user configuration files in the agent settings page', async () => {
    vi.mocked(apiMocks.readCodingAgentConfigFile)
      .mockImplementation(async (agentId: string, key: string) => {
        const path = agentId === 'pi'
          ? (key === 'agents' ? '~/.pi/agent/AGENTS.md' : '~/.pi/agent/settings.json')
          : '~/.claude/settings.json'
        return { key, content: '', absolutePath: path, path, exists: true }
      })

    routeState = { params: { agentId: 'pi', section: 'settings' }, query: {} }
    const CodingAgentConfigView = (await import('@/views/hermes/CodingAgentConfigView.vue')).default
    const wrapper = mount(CodingAgentConfigView)
    routeState = routeMock
    await flushPromises()

    const html = wrapper.html()
    expect(html).toContain('~/.pi/agent/AGENTS.md')
    expect(html).toContain('~/.pi/agent/settings.json')
    expect(html).not.toContain('~/.pi/agent/models.json')
    expect(html).not.toContain('~/.pi/agent/APPEND_SYSTEM.md')
  })
})
