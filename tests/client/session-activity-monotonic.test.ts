// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { newerActivityTime } from '@/stores/hermes/chat'

/**
 * Session activity time must be monotonic.
 *
 * Symptom this pins: opening a session promoted it to "now", then ~12s later a
 * background poll overwrote the timestamp with the server's older `last_active`
 * and the row snapped back down the list.
 */
describe('newerActivityTime', () => {
  it('keeps the newer value when the poll is behind', () => {
    // Locally bumped to 16:40, server still reports 16:09.
    expect(newerActivityTime(16 * 60_000 + 40_000, 16 * 60_000 + 9_000)).toBe(16 * 60_000 + 40_000)
  })

  it('adopts the poll value when the server is ahead (another device)', () => {
    expect(newerActivityTime(16 * 60_000 + 9_000, 16 * 60_000 + 40_000)).toBe(16 * 60_000 + 40_000)
  })

  it('is idempotent, so repeated polls never move the row', () => {
    let t = newerActivityTime(0, 16 * 60_000 + 40_000)!
    for (let i = 0; i < 5; i += 1) t = newerActivityTime(t, 16 * 60_000 + 9_000)!
    expect(t).toBe(16 * 60_000 + 40_000)
  })

  it('treats a missing timestamp as "no information" rather than zero', () => {
    expect(newerActivityTime(undefined, 16 * 60_000 + 40_000)).toBe(16 * 60_000 + 40_000)
    expect(newerActivityTime(16 * 60_000 + 40_000, undefined)).toBe(16 * 60_000 + 40_000)
    expect(newerActivityTime(0, 0)).toBeUndefined()
    expect(newerActivityTime(undefined, undefined)).toBeUndefined()
  })

  it('tolerates junk from the API instead of poisoning the row with NaN', () => {
    const result = newerActivityTime(16 * 60_000 + 40_000, Number.NaN)
    expect(result).toBe(16 * 60_000 + 40_000)
    expect(Number.isNaN(result as number)).toBe(false)
  })
})
