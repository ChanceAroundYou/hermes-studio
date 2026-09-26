import { vi } from 'vitest'

/** The phone-layout breakpoint the client shares (mirrors utils/viewport.ts). */
export const PHONE_MAX_WIDTH = 768

/**
 * Put the test browser at `width`.
 *
 * Sets `window.innerWidth` for the code that measures width, and makes
 * `window.matchMedia('(max-width: ...)')` answer accordingly - which is how the
 * client decides it is in its phone layout. Set this *before* mounting.
 */
export function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width })

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query)
      return {
        matches: width <= (max ? Number(max[1]) : Number.POSITIVE_INFINITY),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }
    }),
  })
}
