/**
 * Static reasoning-effort capability table.
 *
 * Values follow LiteLLM's model map semantics (reasoning_effort_capability.py):
 * medium/high are unconditional for a reasoning deployment, minimal/low are the
 * portable baseline, and xhigh/max only appear where a vendor documents them.
 * A deployment absent from this table is unknown, not permissive.
 *
 * Sources: litellm/router_utils/reasoning_effort_capability.py,
 * litellm/llms/openai/chat/gpt_5_transformation.py,
 * litellm/llms/anthropic/chat/transformation.py.
 */

import { NON_ENUMERIC_PROVIDERS, PORTABLE, UNKNOWN, type Capability } from './reasoning-effort'

const S = (...values: string[]): ReadonlySet<string> => new Set(values)

/** gpt-5 family: none is opt-out, xhigh opt-in. */
const GPT5 = S('minimal', 'low', 'medium', 'high', 'xhigh')
/** o-series and gpt-5 pro/mini reject none and minimal. */
const O_SERIES = S('low', 'medium', 'high')
/** Claude takes a thinking budget instead; no effort enum. */
const NO_EFFORT: ReadonlySet<string> = new Set()

/**
 * provider -> model prefix matcher. Longest prefix wins, so `gpt-5-pro` beats
 * `gpt-5`. A `null` value means the provider takes no effort enum at all.
 */
const PROVIDER_DEFAULTS: Record<string, ReadonlySet<string> | null> = {
  anthropic: NO_EFFORT,
  'claude-oauth': NO_EFFORT,
  deepseek: S('low', 'medium', 'high'),
  grok: S('low', 'medium', 'high'),
  'xai-oauth': S('low', 'medium', 'high'),
  doubao: S('low', 'medium', 'high'),
  minimax: S('low', 'medium', 'high'),
  'minimax-oauth': S('low', 'medium', 'high'),
  zhipu: PORTABLE,
  moonshot: PORTABLE,
  qwen: PORTABLE,
  mimo: PORTABLE,
  edge: PORTABLE,
  opencode: PORTABLE,
  'opencode-free': PORTABLE,
  openrouter: null, // a router in front of many models: infer per model below
  custom: null,
  global: null,
}

const MODEL_RULES: Array<[RegExp, ReadonlySet<string>]> = [
  [/^gpt-5-pro/, S('minimal', 'low', 'medium', 'high', 'xhigh')],
  [/^gpt-5/, GPT5],
  [/^gpt-6/, S('minimal', 'low', 'medium', 'high', 'xhigh', 'max')],
  [/^o[134](?:-|$)/, O_SERIES],
  [/^gpt-oss/, PORTABLE],
]

/** OpenRouter exposes whatever the upstream vendor does; trust the model name. */
const ROUTED_MODEL_RULES: Array<[RegExp, ReadonlySet<string>]> = [
  [/^openai\/(gpt-5-pro)/i, S('minimal', 'low', 'medium', 'high', 'xhigh')],
  [/^openai\/(gpt-5)/i, GPT5],
  [/^openai\/o[134]/i, O_SERIES],
  [/^anthropic\//i, NO_EFFORT],
  [/^deepseek\//i, S('low', 'medium', 'high')],
  [/^(?:x-ai|xai)\//i, S('low', 'medium', 'high')],
]

function bare(model: unknown): string {
  const n = normalizeModel(model)
  const slash = n.lastIndexOf('/')
  return slash >= 0 ? n.slice(slash + 1) : n
}

function normalizeModel(model: unknown): string {
  return typeof model === 'string' ? model.trim().toLowerCase() : ''
}

function normalizeProvider(provider: unknown): string {
  return typeof provider === 'string' ? provider.trim().toLowerCase() : ''
}

/** Layer 1: what we can answer from the table alone. */
export function staticCapability(provider: unknown, model: unknown): Capability {
  const p = normalizeProvider(provider)
  const full = normalizeModel(model)

  if (NON_ENUMERIC_PROVIDERS.has(p)) {
    return {
      supported: NO_EFFORT,
      source: 'static',
      reason: `${p} takes a thinking budget, not a reasoning_effort level`,
    }
  }

  if (p === 'openrouter') {
    const hit = ROUTED_MODEL_RULES.find(([re]) => re.test(full))
    if (hit) return { supported: hit[1], source: 'static' }
    // A router we cannot attribute: unknown beats a guess that fails the turn.
    return { supported: new Set<string>(), source: 'unknown' }
  }

  for (const [re, supported] of MODEL_RULES) {
    if (re.test(bare(full))) return { supported, source: 'static' }
  }

  const fallback = Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, p) ? PROVIDER_DEFAULTS[p] : undefined
  if (fallback === undefined) return UNKNOWN
  if (fallback === null) return { supported: new Set<string>(), source: 'unknown' }
  return { supported: fallback, source: 'family' }
}
