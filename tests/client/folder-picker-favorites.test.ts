// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'

const requestMock = vi.hoisted(() => vi.fn())
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const dialogMock = vi.hoisted(() => ({ warning: vi.fn() }))
const prefsApi = vi.hoisted(() => ({
  fetchWorkspacePreferences: vi.fn(),
  addWorkspaceFavorite: vi.fn(),
  removeWorkspaceFavorite: vi.fn(),
  setProfileDefaultWorkspace: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  request: requestMock,
  getActiveProfileName: vi.fn(() => 'default'),
  getBaseUrlValue: vi.fn(() => ''),
  wsOrigin: vi.fn(() => ({ host: '', prefix: '' })),
}))
vi.mock('@/api/studio/workspace-preferences', () => prefsApi)
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default?.())
    },
  }),
  NDropdown: defineComponent({
    name: 'NDropdown',
    props: { show: Boolean, options: { type: Array, default: () => [] } },
    setup(props) {
      return () => h('div', { class: 'dropdown-stub' }, props.show ? JSON.stringify(props.options) : '')
    },
  }),
  NInput: defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: { type: String, default: '' }, placeholder: String },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('input', {
        value: props.value,
        placeholder: props.placeholder,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  }),
  NModal: defineComponent({ name: 'NModal', setup: (_, { slots }) => () => h('div', slots.default?.()) }),
  NSpace: defineComponent({ name: 'NSpace', setup: (_, { slots }) => () => h('div', slots.default?.()) }),
  NSpin: defineComponent({ name: 'NSpin', setup: () => () => h('div', { class: 'spin-stub' }) }),
  useDialog: () => dialogMock,
  useMessage: () => messageMock,
}))

const TREE = {
  base: '/home/u',
  current: '',
  folders: [
    { name: 'work', path: '/home/u/work', fullPath: '/home/u/work' },
    { name: 'pics', path: '/home/u/pics', fullPath: '/home/u/pics' },
  ],
}

function serverFavorites(paths: string[] = []) {
  prefsApi.fetchWorkspacePreferences.mockResolvedValue({
    favorites: paths,
    defaultWorkspace: '',
    profile: 'default',
  })
  prefsApi.addWorkspaceFavorite.mockImplementation(async (path: string) => [...paths, path])
  prefsApi.removeWorkspaceFavorite.mockImplementation(async (path: string) => paths.filter(p => p !== path))
  prefsApi.setProfileDefaultWorkspace.mockImplementation(async (_profile: string, path: string | null) => ({
    profile: 'default',
    defaultWorkspace: path || '',
  }))
}

async function mountPicker(props: Record<string, unknown> = {}) {
  const wrapper = mount(FolderPicker, { props: { modelValue: null, ...props } })
  await flushPromises()
  return wrapper
}

function rowFor(wrapper: any, label: string) {
  return wrapper.findAll('.folder-item').find((item: any) => item.text().includes(label))!
}

beforeEach(() => {
  vi.clearAllMocks()
  requestMock.mockImplementation(async (url: string) => {
    if (url === '/api/studio/workspace/folders') return TREE
    throw new Error(`Unexpected request: ${url}`)
  })
  serverFavorites()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('FolderPicker workspace favourites', () => {
  it('lists favourites in a row under the directory list', async () => {
    serverFavorites(['/home/u/pics', '/srv/data'])
    const wrapper = await mountPicker()

    const chips = wrapper.find('.folder-shortcuts')
    expect(chips.exists()).toBe(true)
    expect(chips.findAll('.folder-shortcut-chip')).toHaveLength(2)
    expect(chips.text()).toContain('pics')
    expect(chips.text()).toContain('data')

    // ...and it sits after the tree, not above it.
    const html = wrapper.html()
    expect(html.indexOf('folder-tree')).toBeLessThan(html.indexOf('folder-shortcuts'))
  })

  it('hides the row when there is no default and no favourites', async () => {
    const wrapper = await mountPicker()
    expect(wrapper.find('.folder-shortcuts').exists()).toBe(false)
  })

  it('offers no action buttons: favourite/default live only in the context menu', async () => {
    // One gesture vocabulary for the tree. Reintroducing buttons here is what
    // previously made the row look like a feature nobody could find.
    serverFavorites(['/home/u/pics'])
    const wrapper = await mountPicker()
    await wrapper.setProps({ modelValue: '/home/u/work' })
    await nextTick()

    expect(wrapper.findAll('.folder-action')).toHaveLength(0)
    const row = wrapper.find('.folder-shortcuts')
    expect(row.exists()).toBe(true)
    // The row only shows the stored shortcuts.
    expect(row.findAll('.folder-shortcut-chip')).toHaveLength(1)
  })

  it('lays the row out horizontally after the tree', async () => {
    serverFavorites(['/home/u/pics'])
    const wrapper = await mountPicker()
    const row = wrapper.find('.folder-shortcuts-row')
    expect(row.classes()).toContain('folder-shortcuts-row')
    const html = wrapper.html()
    expect(html.indexOf('folder-tree')).toBeLessThan(html.indexOf('folder-shortcuts'))
  })

  it('favourites a directory from the right-click menu', async () => {
    const wrapper = await mountPicker()
    await rowFor(wrapper, 'work').trigger('contextmenu')
    await nextTick()

    const dropdown = wrapper.findComponent({ name: 'NDropdown' })
    expect(JSON.stringify(dropdown.props('options'))).toContain('chat.workspaceFavorite')

    dropdown.vm.$emit('select', 'favorite')
    await flushPromises()

    expect(prefsApi.addWorkspaceFavorite).toHaveBeenCalledWith('/home/u/work')
    expect(wrapper.findAll('.folder-shortcut-name').map((c: any) => c.text())).toContain('work')
  })

  it('offers both features separately, and never conflates them', async () => {
    const wrapper = await mountPicker()
    await rowFor(wrapper, 'work').trigger('contextmenu')
    await nextTick()

    const options = JSON.stringify(wrapper.findComponent({ name: 'NDropdown' }).props('options'))
    expect(options).toContain('chat.workspaceFavorite')
    expect(options).toContain('chat.workspacePin')

    const dropdown = wrapper.findComponent({ name: 'NDropdown' })
    dropdown.vm.$emit('select', 'default')
    await flushPromises()

    // Setting the profile default must not touch the shared favourites list.
    expect(prefsApi.setProfileDefaultWorkspace).toHaveBeenCalledWith('default', '/home/u/work')
    expect(prefsApi.addWorkspaceFavorite).not.toHaveBeenCalled()
  })

  it('unfavourites from the context menu without touching the default', async () => {
    serverFavorites(['/home/u/pics'])
    const wrapper = await mountPicker()

    await wrapper.find('.folder-shortcut-chip').trigger('contextmenu')
    await nextTick()
    const dropdown = wrapper.findComponent({ name: 'NDropdown' })
    expect(JSON.stringify(dropdown.props('options'))).toContain('chat.workspaceUnfavorite')

    dropdown.vm.$emit('select', 'favorite')
    await flushPromises()

    expect(prefsApi.removeWorkspaceFavorite).toHaveBeenCalledWith('/home/u/pics')
    expect(prefsApi.setProfileDefaultWorkspace).not.toHaveBeenCalled()
  })

  it('puts the profile default first in the row, before the favourites', async () => {
    serverFavorites(['/home/u/pics'])
    prefsApi.fetchWorkspacePreferences.mockResolvedValue({
      favorites: ['/home/u/pics'],
      defaultWorkspace: '/home/u/work',
      profile: 'default',
    })
    const wrapper = await mountPicker()

    expect(wrapper.findAll('.folder-shortcut-name').map((n: any) => n.text())).toEqual(['work', 'pics'])
  })

  it('shows the default with a circle even when it is not a favourite', async () => {
    serverFavorites(['/home/u/pics'])
    prefsApi.fetchWorkspacePreferences.mockResolvedValue({
      favorites: ['/home/u/pics'],
      defaultWorkspace: '/home/u/work',
      profile: 'default',
    })
    const wrapper = await mountPicker()

    const first = wrapper.findAll('.folder-shortcut-chip')[0]
    expect(first.find('.folder-shortcut-default').exists()).toBe(true)
    expect(first.find('.folder-shortcut-star').exists()).toBe(false)
  })

  it('shows circle then star when the default is also a favourite', async () => {
    serverFavorites(['/home/u/pics'])
    prefsApi.fetchWorkspacePreferences.mockResolvedValue({
      favorites: ['/home/u/pics'],
      defaultWorkspace: '/home/u/pics',
      profile: 'default',
    })
    const wrapper = await mountPicker()

    // One entry, not two: the same path must not be listed twice.
    expect(wrapper.findAll('.folder-shortcut-chip')).toHaveLength(1)
    const marks = wrapper.findAll('.folder-shortcut-chip')[0]
      .findAll('span')
      .map((span: any) => span.text())
      .filter((text: string) => text === '\u25cf' || text === '\u2605')
    expect(marks).toEqual(['\u25cf', '\u2605'])
  })

  it('lists the default first even when the server sends it last', async () => {
    prefsApi.fetchWorkspacePreferences.mockResolvedValue({
      favorites: ['/a', '/b'],
      defaultWorkspace: '/c',
      profile: 'default',
    })
    const wrapper = await mountPicker()

    expect(wrapper.findAll('.folder-shortcut-name').map((n: any) => n.text())).toEqual(['c', 'a', 'b'])
  })

  it('opens the same menu on a long press, because touch devices send no contextmenu', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPicker()

    await rowFor(wrapper, 'work').trigger('touchstart', { touches: [{ clientX: 12, clientY: 34 }] })
    vi.advanceTimersByTime(500)
    await flushPromises()
    await nextTick()

    const dropdown = wrapper.findComponent({ name: 'NDropdown' })
    expect(dropdown.props('show')).toBe(true)
    expect(JSON.stringify(dropdown.props('options'))).toContain('chat.workspaceFavorite')

    // And the long press must not also select that row.
    await rowFor(wrapper, 'work').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
