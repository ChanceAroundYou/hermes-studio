// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useMediaQuery, useMobileLayout, useNarrowDrawer } from '@/composables/useMediaQuery'
import {
  MOBILE_LAYOUT_BREAKPOINT,
  MOBILE_LAYOUT_QUERY,
  NARROW_DRAWER_BREAKPOINT,
  NARROW_DRAWER_QUERY,
  isMobileLayoutWidth,
  matchesMediaQuery,
} from '@/utils/viewport'

type Listener = (event: { matches: boolean }) => void

function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>()
  const list = {
    matches: initialMatches,
    media: '',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: Listener) => { listeners.add(listener) }),
    removeEventListener: vi.fn((_type: string, listener: Listener) => { listeners.delete(listener) }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  const matchMedia = vi.fn(() => list)
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMedia })
  return {
    matchMedia,
    list,
    listenerCount: () => listeners.size,
    fire(matches: boolean) {
      list.matches = matches
      for (const listener of listeners) listener({ matches })
    },
  }
}

/** Reads the composable's value from inside a render function, so it stays reactive. */
function mountProbe(useValue: () => { value: boolean }) {
  const seen: { value: boolean | null } = { value: null }
  const wrapper = mount(defineComponent({
    setup() {
      const value = useValue()
      return () => {
        seen.value = value.value
        return h('div')
      }
    },
  }))
  return { wrapper, seen }
}

describe('viewport primitives', () => {
  it('names the two breakpoints the client actually uses', () => {
    expect(MOBILE_LAYOUT_BREAKPOINT).toBe(768)
    expect(MOBILE_LAYOUT_QUERY).toBe('(max-width: 768px)')
    expect(NARROW_DRAWER_BREAKPOINT).toBe(640)
    expect(NARROW_DRAWER_QUERY).toBe('(max-width: 640px)')
  })

  it('treats the breakpoint itself as the phone layout', () => {
    expect(isMobileLayoutWidth(768)).toBe(true)
    expect(isMobileLayoutWidth(769)).toBe(false)
  })

  it('reads a query defensively', () => {
    const stub = stubMatchMedia(true)
    expect(matchesMediaQuery(MOBILE_LAYOUT_QUERY)).toBe(true)
    expect(stub.matchMedia).toHaveBeenCalledWith(MOBILE_LAYOUT_QUERY)

    stub.fire(false)
    expect(matchesMediaQuery(MOBILE_LAYOUT_QUERY)).toBe(false)

    // A restored stub returns nothing; a render must survive it.
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: vi.fn() })
    expect(matchesMediaQuery(MOBILE_LAYOUT_QUERY)).toBe(false)
  })
})

describe('useMediaQuery', () => {
  let stub: ReturnType<typeof stubMatchMedia>

  beforeEach(() => {
    stub = stubMatchMedia(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the query synchronously so the first paint is already right', () => {
    stub = stubMatchMedia(true)
    const { wrapper, seen } = mountProbe(useMobileLayout)
    expect(seen.value).toBe(true)
    wrapper.unmount()
  })

  it('follows the media query and stops listening on unmount', async () => {
    const { wrapper, seen } = mountProbe(useMobileLayout)
    expect(seen.value).toBe(false)
    expect(stub.listenerCount()).toBe(1)

    stub.fire(true)
    await nextTick()
    expect(seen.value).toBe(true)

    wrapper.unmount()
    expect(stub.listenerCount()).toBe(0)
  })

  it('keeps the mobile and narrow-drawer queries apart', async () => {
    const { wrapper, seen } = mountProbe(useNarrowDrawer)
    expect(stub.matchMedia).toHaveBeenCalledWith(NARROW_DRAWER_QUERY)
    expect(seen.value).toBe(false)

    stub.fire(true)
    await nextTick()
    expect(seen.value).toBe(true)
    wrapper.unmount()
  })

  it('tolerates a matchMedia stub that returns nothing', () => {
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: vi.fn() })
    const { wrapper, seen } = mountProbe(() => useMediaQuery(MOBILE_LAYOUT_QUERY))
    expect(seen.value).toBe(false)
    wrapper.unmount()
  })
})
