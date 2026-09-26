import { describe, expect, it } from 'vitest'
import {
  BYTE_UNITS_WITH_TB,
  errorMessage,
  formatBytes,
  formatCompactCount,
  formatDateTime,
  formatShortDateTime,
} from '@/utils/format'

// Every case below pins the exact string one of the migrated call sites produced
// before the formatters were unified, so a regression shows up as a failing
// expectation rather than as a subtly different label in the UI.

describe('formatBytes', () => {
  it('keeps the attachment/composer rendering (B/KB/MB/GB, one decimal)', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })

  it('keeps the file preview rendering (no GB unit, empty for garbage)', () => {
    const options = { units: ['B', 'KB', 'MB'] } as const
    expect(formatBytes(Number.NaN, options)).toBe('')
    expect(formatBytes(-1, options)).toBe('')
    expect(formatBytes(0, options)).toBe('0 B')
    expect(formatBytes(1024, options)).toBe('1.0 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024, options)).toBe('5120.0 MB')
  })

  it('keeps the file list rendering (em dash for empty, GB unit)', () => {
    expect(formatBytes(0, { zeroFallback: '—' })).toBe('—')
    expect(formatBytes(1024, { zeroFallback: '—' })).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024, { zeroFallback: '—' })).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024 * 1024, { zeroFallback: '—' })).toBe('5.0 GB')
  })

  it('keeps the job run rendering (no separator)', () => {
    expect(formatBytes(0, { separator: '' })).toBe('0B')
    expect(formatBytes(1024, { separator: '' })).toBe('1.0KB')
    expect(formatBytes(1024 * 1024, { separator: '' })).toBe('1.0MB')
  })

  it('keeps the model archive rendering (unit-based decimals, em dash fallbacks)', () => {
    const options = { decimals: 'unit-based', zeroFallback: '—', invalidFallback: '—' } as const
    expect(formatBytes(0, options)).toBe('—')
    expect(formatBytes(-1, options)).toBe('—')
    expect(formatBytes(512, options)).toBe('512 B')
    expect(formatBytes(1024, options)).toBe('1 KB')
    expect(formatBytes(1024 * 1024, options)).toBe('1.0 MB')
  })

  it('keeps the version/transfer rendering (significant decimals, TB units)', () => {
    const options = {
      units: BYTE_UNITS_WITH_TB,
      decimals: 'significant',
      invalidFallback: '0 B',
    } as const
    expect(formatBytes(Number.NaN, options)).toBe('0 B')
    expect(formatBytes(-5, options)).toBe('0 B')
    expect(formatBytes(500, options)).toBe('500 B')
    expect(formatBytes(1500, options)).toBe('1.5 KB')
    expect(formatBytes(15360, options)).toBe('15 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024, options)).toBe('5.0 GB')
  })

  it('keeps the version modal rendering (empty fallbacks)', () => {
    const options = { decimals: 'significant', zeroFallback: '', invalidFallback: '' } as const
    expect(formatBytes(0, options)).toBe('')
    expect(formatBytes(512, options)).toBe('512 B')
    expect(formatBytes(1536, options)).toBe('1.5 KB')
  })

  it('keeps the performance rendering (TB units, dash for garbage)', () => {
    const options = { units: BYTE_UNITS_WITH_TB, invalidFallback: '-' } as const
    expect(formatBytes(Number.NaN, options)).toBe('-')
    expect(formatBytes(512, options)).toBe('512 B')
    expect(formatBytes(5 * 1024 * 1024 * 1024, options)).toBe('5.0 GB')
    expect(formatBytes(3 * 1024 ** 4, options)).toBe('3.0 TB')
  })
})

describe('formatCompactCount', () => {
  it('formats token counts the way the context meter and usage views do', () => {
    expect(formatCompactCount(0)).toBe('0')
    expect(formatCompactCount(999)).toBe('999')
    expect(formatCompactCount(1500)).toBe('1.5K')
    expect(formatCompactCount(2_500_000)).toBe('2.5M')
  })

  it('honours the lowercase suffix the composer and group rooms use', () => {
    expect(formatCompactCount(1500, { kilo: 'k' })).toBe('1.5k')
    expect(formatCompactCount(2_500_000, { kilo: 'k' })).toBe('2.5M')
  })
})

describe('formatDateTime', () => {
  it('formats epoch milliseconds, epoch seconds and ISO strings', () => {
    expect(formatDateTime(1789996977000)).toBe(new Date(1789996977000).toLocaleString())
    expect(formatDateTime(1789996977, { unit: 's' })).toBe(new Date(1789996977 * 1000).toLocaleString())
    expect(formatDateTime('2026-09-26T10:20:00')).toBe(new Date('2026-09-26T10:20:00').toLocaleString())
  })

  it('keeps each migrated fallback', () => {
    expect(formatDateTime(0)).toBe('-')
    expect(formatDateTime(0, { fallback: '—' })).toBe('—')
    expect(formatDateTime(null, { fallback: 'never' })).toBe('never')
    expect(formatDateTime('', { fallback: '-' })).toBe('-')
    expect(formatDateTime('not-a-date', { fallback: '-' })).toBe('-')
    expect(formatDateTime('not-a-date', { fallback: '-', invalid: 'raw' })).toBe('not-a-date')
  })
})

describe('formatShortDateTime', () => {
  it('formats a compact month/day clock label for both units', () => {
    const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } as const
    expect(formatShortDateTime(1789996977000)).toBe(new Date(1789996977000).toLocaleString([], options))
    expect(formatShortDateTime(1789996977, { unit: 's' })).toBe(new Date(1789996977 * 1000).toLocaleString([], options))
    expect(formatShortDateTime(0)).toBe('')
  })
})

describe('errorMessage', () => {
  it('unwraps at every level the client actually throws at it', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('  plain  ')).toBe('plain')
    expect(errorMessage(null)).toBe('')
    expect(errorMessage(undefined)).toBe('')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage({ message: 'from message' })).toBe('from message')
    expect(errorMessage({ error: 'from error' })).toBe('from error')
    expect(errorMessage({ detail: 'from detail' })).toBe('from detail')
    expect(errorMessage([{ message: 'first' }, 'second'])).toBe('first\nsecond')
    expect(errorMessage({ unknown: true })).toBe('{"unknown":true}')
  })

  it('falls back to String() for a value it cannot serialise', () => {
    // The chat store used to hand circular payloads to its own copy of this
    // helper; the shared one keeps the same last-resort behaviour.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe('[object Object]')
  })
})
