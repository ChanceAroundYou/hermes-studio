/**
 * The single home for the value formatting the Studio UI used to copy-paste.
 *
 * These helpers existed 5-13 times each (a byte formatter in 13 components, an
 * error unwrapper in 6, an epoch -> locale date in 7, a compact token count in
 * 7), which is exactly why the same number could render differently on two
 * screens. Every option below exists because a real call site needed it, and the
 * defaults reproduce the most common one.
 *
 * Timestamps deliberately have three clearly scoped homes rather than one:
 * - `formatDateTime` / `formatShortDateTime` (here): an explicit epoch -> locale
 *   string, used for log/detail rows.
 * - `utils/chat-timestamp.ts`: day-aware bubble stamps ("10:20" today,
 *   "09/26, 10:20" this year).
 * - `shared/session-display.ts`: compact list-row stamps ("10:20" today, "Sep 26").
 */

export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const
export const BYTE_UNITS_WITH_TB = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export type ByteDecimals = 'tenths' | 'unit-based' | 'significant'

export interface FormatBytesOptions {
  /** Unit ladder to walk up. Defaults to BYTE_UNITS. */
  units?: readonly string[]
  /**
   * 'tenths' (default): no decimals for the first unit, one above it.
   * 'unit-based': no decimals for the first two units, one above those.
   * 'significant': no decimals once the mantissa reaches 10 (or on the first unit).
   */
  decimals?: ByteDecimals
  /** Between the number and the unit. Defaults to a single space. */
  separator?: string
  /** Returned for a missing, non-finite or negative value. Defaults to ''. */
  invalidFallback?: string
  /** Returned for exactly 0. Defaults to the normally formatted zero. */
  zeroFallback?: string
}

function byteDigits(amount: number, unit: number, mode: ByteDecimals): number {
  if (mode === 'unit-based') return unit > 1 ? 1 : 0
  if (mode === 'significant') return amount >= 10 || unit === 0 ? 0 : 1
  return unit === 0 ? 0 : 1
}

/** Formats a byte count as "1.5 MB". */
export function formatBytes(value: number | null | undefined, options: FormatBytesOptions = {}): string {
  const units = options.units ?? BYTE_UNITS
  const separator = options.separator ?? ' '
  if (value == null || !Number.isFinite(value) || value < 0) return options.invalidFallback ?? ''
  if (value === 0) return options.zeroFallback ?? `0${separator}${units[0]}`
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(byteDigits(amount, unit, options.decimals ?? 'tenths'))}${separator}${units[unit]}`
}

export interface FormatCompactCountOptions {
  /** The thousand suffix letter. Defaults to 'K'. */
  kilo?: 'K' | 'k'
}

/** Formats a count as "1.2K" / "3.4M"; below 1000 it stays verbatim. */
export function formatCompactCount(value: number, options: FormatCompactCountOptions = {}): string {
  const kilo = options.kilo ?? 'K'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}${kilo}`
  return String(value)
}

export interface FormatDateTimeOptions {
  /** Whether a numeric value is epoch milliseconds ('ms', default) or seconds ('s'). */
  unit?: 'ms' | 's'
  /** Returned for a missing value. Defaults to '-'. */
  fallback?: string
  /** How to render an unparsable value: the fallback, or the raw input. */
  invalid?: 'fallback' | 'raw'
}

/** Formats an epoch value (or a date string) with the viewer's locale. */
export function formatDateTime(
  value: number | string | null | undefined,
  options: FormatDateTimeOptions = {},
): string {
  const { unit = 'ms', fallback = '-', invalid = 'fallback' } = options
  if (value == null || value === '' || (typeof value === 'number' && value === 0)) return fallback
  const date = unit === 's' && typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return invalid === 'raw' ? String(value) : fallback
  return date.toLocaleString()
}

/** Formats an epoch value as a compact "Sep 26, 10:37" label. */
export function formatShortDateTime(
  value: number | null | undefined,
  options: { unit?: 'ms' | 's'; fallback?: string } = {},
): string {
  const { unit = 'ms', fallback = '' } = options
  if (!value) return fallback
  const date = new Date(unit === 's' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Unwraps an unknown thrown value into displayable text.
 *
 * This is the client's only error unwrapper: `utils/http-error.ts`, the chat
 * store and six views each grew their own copy before this existed.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error == null) return ''
  if (typeof error !== 'object') return String(error).trim()

  if (Array.isArray(error)) {
    return error.map(errorMessage).filter(Boolean).join('\n')
  }

  const record = error as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description', 'code']) {
    const text = errorMessage(record[key])
    if (text) return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
