/**
 * The client's viewport breakpoints, in one place.
 *
 * The same numbers used to be spelled out at ~30 call sites as a bare
 * `window.innerWidth <= 768` or a `matchMedia('(max-width: 768px)')`, so a
 * layout tweak meant hunting for every copy. Reactive consumers should use
 * `useMobileLayout()` / `useNarrowDrawer()` from `@/composables/useMediaQuery`
 * instead of reading these directly.
 */

/** At or below this width the client switches to its phone layout. */
export const MOBILE_LAYOUT_BREAKPOINT = 768
export const MOBILE_LAYOUT_QUERY = `(max-width: ${MOBILE_LAYOUT_BREAKPOINT}px)`

/** Below this width a detail drawer covers the viewport instead of floating. */
export const NARROW_DRAWER_BREAKPOINT = 640
export const NARROW_DRAWER_QUERY = `(max-width: ${NARROW_DRAWER_BREAKPOINT}px)`

/** SSR/jsdom-safe one-shot media query read. */
export function matchesMediaQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  // A stubbed `matchMedia` (tests restore one) may return nothing at all.
  return Boolean(window.matchMedia(query)?.matches)
}

/** The width-based half of the phone-layout rule (used by resize handlers). */
export function isMobileLayoutWidth(width: number): boolean {
  return width <= MOBILE_LAYOUT_BREAKPOINT
}
