import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { MOBILE_LAYOUT_QUERY, NARROW_DRAWER_QUERY, matchesMediaQuery } from '@/utils/viewport'

/**
 * A reactive media query.
 *
 * This replaces the `let mobileQuery` / `handleMobileChange` pair that nine
 * components used to hand-roll (and that four more re-implemented as an
 * `isMobile = ref(matchMedia(...))`): the value is read synchronously so the
 * first paint is already correct, the listener is registered once with the
 * component and removed with it, and no component has to remember the
 * `typeof window === 'undefined'` guard.
 */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(matchesMediaQuery(query))
  let mediaQuery: MediaQueryList | null = null

  function onChange(event: MediaQueryList | MediaQueryListEvent | null | undefined) {
    matches.value = Boolean(event?.matches)
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    mediaQuery = window.matchMedia(query) ?? null
    if (!mediaQuery) return
    onChange(mediaQuery)
    mediaQuery.addEventListener('change', onChange)
  })

  onUnmounted(() => {
    mediaQuery?.removeEventListener('change', onChange)
    mediaQuery = null
  })

  return matches
}

/** True while the client is in its phone layout (width <= 768). */
export function useMobileLayout(): Ref<boolean> {
  return useMediaQuery(MOBILE_LAYOUT_QUERY)
}

/** True while a detail drawer has to take the full width (width <= 640). */
export function useNarrowDrawer(): Ref<boolean> {
  return useMediaQuery(NARROW_DRAWER_QUERY)
}
