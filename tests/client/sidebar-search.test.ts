// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const openSessionSearchMock = vi.hoisted(() => vi.fn())
const mockAppStore = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: 'test',
  latestVersion: '',
  isDocker: false,
  updateAvailable: false,
  clientOutdated: false,
  updating: false,
  toggleSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  closeSidebar: vi.fn(),
  doUpdate: vi.fn(),
  reloadClient: vi.fn(),
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRoute: () => ({ name: 'hermes.chat' }),
    useRouter: () => ({ push: vi.fn(), hasRoute: () => true }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  createI18n: () => ({
    global: { locale: { value: 'en' }, setLocaleMessage: vi.fn() },
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('/logo.png', () => ({
  default: 'logo.png',
}))

vi.mock('@/components/layout/ProfileSelector.vue', () => ({
  default: { name: 'ProfileSelector', template: '<div />' },
}))

vi.mock('@/components/layout/ModelSelector.vue', () => ({
  default: { name: 'ModelSelector', template: '<div />' },
}))

vi.mock('@/components/layout/LanguageSwitch.vue', () => ({
  default: { name: 'LanguageSwitch', template: '<div />' },
}))

vi.mock('@/components/layout/ThemeSwitch.vue', () => ({
  default: { name: 'ThemeSwitch', template: '<div />' },
}))

vi.mock('@/components/common/RouteLinkItem.vue', () => ({
  default: {
    name: 'RouteLinkItem',
    props: ['to', 'active'],
    template: '<a class="route-link-item" :class="{ active }" href="#"><slot /></a>',
  },
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
    NButton: {
      template: '<button v-bind="$attrs"><slot /></button>',
    },
    NModal: {
      props: ['show'],
      template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
    },
    NSelect: {
      template: '<div />',
    },
  }
})

import AppSidebar from '@/components/layout/AppSidebar.vue'

function fakeJwt(payload: Record<string, unknown>) {
  return `header.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.signature`
}

describe('AppSidebar navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
    openSessionSearchMock.mockClear()
    mockAppStore.serverVersion = 'test'
    mockAppStore.latestVersion = ''
    mockAppStore.isDocker = false
    mockAppStore.updateAvailable = false
    mockAppStore.clientOutdated = false
    mockAppStore.updating = false
    mockAppStore.sidebarCollapsed = false
    mockAppStore.reloadClient.mockClear()
    mockAppStore.doUpdate.mockReset()
    mockAppStore.doUpdate.mockResolvedValue(false)
  })

  it('keeps page-sidebar-only actions out of the app sidebar', () => {
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.search')
    expect(wrapper.text()).not.toContain('sidebar.reloadClientVersion')
    expect(wrapper.find('.sidebar-return-tab').exists()).toBe(true)
  })

  it('no longer hosts version management inside the app sidebar', async () => {
    const webWrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    })

    expect(webWrapper.find('.version-management-btn').exists()).toBe(false)
    expect(webWrapper.find('.version-management-modal-stub').exists()).toBe(false)

    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true }
    const desktopWrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    })

    expect(desktopWrapper.find('.version-management-btn').exists()).toBe(false)
    expect(desktopWrapper.find('.version-management-modal-stub').exists()).toBe(false)
  })

  it('keeps the collapsed sidebar width compact', async () => {
    mockAppStore.sidebarCollapsed = true
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.classes()).toContain('collapsed')
    expect(wrapper.findAll('.nav-group-label').length).toBe(0)
  })

  it('keeps removed entries out of the app sidebar while preserving settings', async () => {
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.mcp')
    expect(wrapper.text()).not.toContain('sidebar.devices')
    expect(wrapper.text()).toContain('sidebar.theme')
  })

})
