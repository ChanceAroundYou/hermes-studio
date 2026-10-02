/**
 * Reasoning-effort compatibility.
 *
 * The UI offers none/minimal/low/medium/high/xhigh/max. Most providers accept
 * only part of that: some reject xhigh/max outright, Anthropic has no effort
 * enum at all (it takes thinking.budget_tokens), and a custom OpenAI-compatible
 * endpoint may know only the four portable values. Sending an unsupported value
 * fails the whole turn, so we resolve what a deployment actually accepts and
 * stay inside it.
 *
 * Design follows LiteLLM's reasoning_effort_capability.py:
 *  - medium/high are unconditional for a reasoning model; minimal/low are
 *    opt-out; xhigh/max are opt-in. A missing signal is NOT a yes.
 *  - An unknown deployment resolves to "nothing known", never to defaults.
 *    Guessing advertises levels the provider rejects.
 *  - We fail closed. An unknown provider gets no effort parameter at all
 *    rather than one that may fail the request.
 *
 * Three layers, intersected. Any layer that says no wins:
 *   1. static   built-in table for deployments we know
 *   2. observed what this process actually saw succeed or fail, with a TTL
 *   3. family   conservative inference for a model we do not know by name
 */

export const REASONING_EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORT_LADDER)[number]

/** Every OpenAI-compatible deployment is expected to take these. */
export const PORTABLE: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high'])

/** Providers with no effort enum; we decline to override their thinking level. */
export const NON_ENUMERIC_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'claude-oauth'])

export interface Capability {
  /** Levels this deployment accepts, ascending. Empty means: send nothing. */
  readonly supported: ReadonlySet<string>
  /** Why we reached that answer, for the adjustment log. */
  readonly source: 'static' | 'observed' | 'family' | 'unknown'
  /** Human-readable reason when the request was not honoured as asked. */
  readonly reason?: string
}

export const UNKNOWN: Capability = Object.freeze({ supported: new Set<string>(), source: 'unknown' as const })

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(normalize(value))
}

export function ceilingIndex(value: unknown): number {
  return REASONING_EFFORT_LADDER.indexOf(normalize(value) as ReasoningEffort)
}

/** Highest entry <= `effort` that `supported` allows. '' means send nothing. */
export function pickSupported(effort: unknown, supported: ReadonlySet<string>): ReasoningEffort | '' {
  let i = ceilingIndex(effort)
  if (i < 0) return ''
  for (; i >= 0; i -= 1) {
    const candidate = REASONING_EFFORT_LADDER[i]
    if (supported.has(candidate)) return candidate
  }
  return ''
}

/** One rung below `effort`, used when a live request proves a value wrong. */
export function stepDown(effort: unknown): ReasoningEffort | '' {
  const i = ceilingIndex(effort)
  return i <= 0 ? '' : REASONING_EFFORT_LADDER[i - 1]
}

/**
 * Providers name the rejected field in several shapes; stay tolerant so a new
 * wording still counts as "this level is unsupported" instead of surfacing as an
 * opaque turn failure.
 */
export function isReasoningEffortUnsupported(error: unknown): boolean {
  const text = errorText(error)
  if (!text) return false
  if (text.includes('reasoning_effort_not_supported')) return true
  return (
    /reasoning[_ ]effort[^\n]{0,100}(not supported|unsupported|invalid|unrecognized|unknown|not allowed)/i.test(text) ||
    /(not supported|unsupported|invalid|unrecognized|unknown|not allowed)[^\n]{0,100}reasoning[_ ]effort/i.test(text)
  )
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 3) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    const extra = error as { body?: unknown; response?: unknown; data?: unknown }
    return [error.message, errorText(extra.body, depth + 1), errorText(extra.response, depth + 1), errorText(extra.data, depth + 1)]
      .filter(Boolean)
      .join(' ')
  }
  if (Array.isArray(error)) {
    return error.map(item => errorText(item, depth + 1)).filter(Boolean).join(' ')
  }
  if (error && typeof error === 'object') {
    // Providers nest the real message ({error:{message}}, {detail}, {data:{...}}),
    // so walk the values rather than only the top-level string fields.
    return Object.values(error as Record<string, unknown>)
      .map(value => errorText(value, depth + 1))
      .filter(Boolean)
      .join(' ')
  }
  if (typeof error === 'number' || typeof error === 'boolean') return ''
  return ''
}
