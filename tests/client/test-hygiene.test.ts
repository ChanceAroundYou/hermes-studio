// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

/**
 * The global stubs in `tests/setup.ts` had two leaks that made the suite
 * order-dependent once the machine was busy:
 *
 * - `vi.restoreAllMocks()` empties the `matchMedia` stub, and it stayed empty
 *   for every later test in that file, so a component reading
 *   `matchMedia(...).matches` during render crashed;
 * - fake timers were never restored, so a test that froze time froze it for its
 *   neighbours and they timed out.
 *
 * The setup now reinstalls the browser globals before every test and puts real
 * timers back after every test. The order below is deliberate: one test breaks
 * the environment, the next one proves a fresh start.
 */
describe('test environment hygiene', () => {
  it('empties the matchMedia stub for the test that restores all mocks', () => {
    vi.restoreAllMocks()
    // What the raw behaviour looks like; no component may rely on matchMedia
    // after its own restoreAllMocks() call.
    expect(window.matchMedia('(max-width: 768px)')?.matches).toBeUndefined()
  })

  it('still gives the next test a working matchMedia', () => {
    const query = window.matchMedia('(max-width: 768px)')
    expect(query).toBeDefined()
    expect(typeof query.matches).toBe('boolean')
    expect(typeof query.addEventListener).toBe('function')
    expect(typeof query.removeEventListener).toBe('function')
  })

  it('gives every test a working localStorage', () => {
    expect(window.localStorage.getItem('missing')).toBeNull()
    window.localStorage.setItem('hygiene', 'ok')
    expect(window.localStorage.getItem('hygiene')).toBe('ok')
  })

  it('enables fake timers on purpose, for the next test to notice', () => {
    vi.useFakeTimers()
    expect(vi.isFakeTimers()).toBe(true)
  })

  it('starts with real timers even though the previous test froze them', () => {
    expect(vi.isFakeTimers()).toBe(false)
    expect(Date.now()).toBeGreaterThan(1_600_000_000_000)
  })
})
