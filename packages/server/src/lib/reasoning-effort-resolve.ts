/**
 * Resolving and adapting reasoning_effort.
 *
 * See reasoning-effort.ts for the rationale. This module adds the observed layer
 * (what this process actually saw succeed or fail) and the single-flight guard
 * that keeps concurrent first calls from all sending an unproven value.
 */

import {
  REASONING_EFFORT_LADDER,
  ceilingIndex,
  isReasoningEffortUnsupported,
  pickSupported,
  stepDown,
  type Capability,
  type ReasoningEffort,
} from './reasoning-effort'
import { staticCapability } from './reasoning-effort-capabilities'
import {
  loadEffortCapabilities,
  registerEffortCapabilityHooks,
  saveEffortCapability,
} from '../modules/studio/repositories/reasoning-effort-capability-store'

/** Observations expire so a provider upgrade can widen support again. */
const OBSERVED_TTL_MS = 6 * 60 * 60 * 1000

interface Observation {
  supported: Set<string>
  rejected: Set<string>
  seenAt: number
}

const observed = new Map<string, Observation>()
/** In-flight probes per key, so a burst of requests makes one attempt. */
const probes = new Map<string, Promise<string>>()
/** Pending writes, so a busy deployment does not hit SQLite on every turn. */
const dirty = new Map<string, number>()
const FLUSH_DEBOUNCE_MS = 60_000

function scheduleFlush(provider: string, model: string): void {
  const key = `${provider}::${model}`
  if (dirty.has(key)) return
  dirty.set(key, Date.now())
  const timer = setTimeout(() => {
    dirty.delete(key)
    const entry = observed.get(key)
    if (!entry) return
    saveEffortCapability(provider, model, [...entry.supported], [...entry.rejected])
  }, FLUSH_DEBOUNCE_MS)
  // Never hold the process open for a cache write.
  timer.unref?.()
}

function flushNow(provider: string, model: string): void {
  const key = `${provider}::${model}`
  dirty.delete(key)
  const entry = observed.get(key)
  if (!entry) return
  saveEffortCapability(provider, model, [...entry.supported], [...entry.rejected])
}

/** Seed an in-memory entry from a durable row, without marking it dirty. */
function hydrateEntry(provider: string, model: string, supported: string[], rejected: string[]): void {
  if (!supported.length && !rejected.length) return
  const key = `${provider.toLowerCase()}::${model.toLowerCase()}`
  observed.set(key, {
    supported: new Set(supported),
    rejected: new Set(rejected),
    seenAt: Date.now(),
  })
}


function keyOf(provider: unknown, model: unknown): string {
  const p = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  const m = typeof model === 'string' ? model.trim().toLowerCase() : ''
  return `${p || 'unknown'}::${m || 'unknown'}`
}

function live(key: string): Observation | undefined {
  const entry = observed.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.seenAt > OBSERVED_TTL_MS) {
    observed.delete(key)
    return undefined
  }
  return entry
}

let durableLoaded = false

/**
 * Pull the durable rows in on first use rather than at boot. The table is a
 * cache, not a boot dependency, so a database that is not open yet simply means
 * we learn again from live traffic.
 */
function ensureDurableLoaded(): void {
  if (durableLoaded) return
  durableLoaded = true
  loadEffortCapabilities()
}

/** Layer 2 merged with 1 and 3: the intersection decides. */
export function capabilityFor(provider: unknown, model: unknown): Capability {
  ensureDurableLoaded()
  const base = staticCapability(provider, model)
  const entry = live(keyOf(provider, model))
  if (!entry) return base

  const supported = new Set(base.supported)
  if (entry.supported.size > 0) {
    // Observed success is proof; widen only where the table did not forbid.
    for (const value of entry.supported) {
      if (base.source !== 'static' || base.supported.has(value)) supported.add(value)
    }
  }
  for (const value of entry.rejected) supported.delete(value)

  return {
    supported,
    source: entry.supported.size || entry.rejected.size ? 'observed' : base.source,
    reason: base.reason,
  }
}

export function noteSupported(provider: unknown, model: unknown, effort: unknown): void {
  const normalized = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  if (!normalized) return
  const key = keyOf(provider, model)
  const entry = live(key) ?? { supported: new Set<string>(), rejected: new Set<string>(), seenAt: Date.now() }
  entry.supported.add(normalized)
  entry.rejected.delete(normalized)
  entry.seenAt = Date.now()
  observed.set(key, entry)
  scheduleFlush(String(provider ?? '').toLowerCase(), String(model ?? '').toLowerCase())
}

export function noteUnsupported(provider: unknown, model: unknown, effort: unknown): void {
  const normalized = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  if (!normalized) return
  const key = keyOf(provider, model)
  const entry = live(key) ?? { supported: new Set<string>(), rejected: new Set<string>(), seenAt: Date.now() }
  entry.rejected.add(normalized)
  entry.supported.delete(normalized)
  entry.seenAt = Date.now()
  observed.set(key, entry)
  scheduleFlush(String(provider ?? '').toLowerCase(), String(model ?? '').toLowerCase())
}

export function resetEffortObservations(): void {
  observed.clear()
  probes.clear()
  dirty.clear()
  durableLoaded = false
}

/** Re-read the durable table. Call once during boot. */
export function restoreEffortCapabilities(): number {
  return loadEffortCapabilities()
}

/** Force a write for a deployment that just learned something. */
export function persistEffortNow(provider: unknown, model: unknown): void {
  flushNow(String(provider ?? '').toLowerCase(), String(model ?? '').toLowerCase())
}

export interface EffortDecision {
  /** What to actually send. '' means send no parameter. */
  readonly applied: string
  readonly requested: string
  readonly source: Capability['source']
  readonly adjusted: boolean
  readonly reason?: string
}

/**
 * Decide once, for both paths. Fail closed: when nothing is known about a
 * deployment we send no effort rather than one that may fail the turn.
 */
export function decideReasoningEffort(
  provider: unknown,
  model: unknown,
  requested: unknown,
): EffortDecision {
  const requestedValue = typeof requested === 'string' ? requested.trim().toLowerCase() : ''
  if (!requestedValue) {
    return { applied: '', requested: requestedValue, source: 'static', adjusted: false }
  }

  const capability = capabilityFor(provider, model)
  const applied = pickSupported(requestedValue, capability.supported)

  if (applied === requestedValue) {
    return { applied, requested: requestedValue, source: capability.source, adjusted: false, reason: capability.reason }
  }

  const reason = applied
    ? `${capability.source} capability table tops out below ${requestedValue}`
    : capability.reason ?? `no reasoning_effort level is known to work for this deployment`
  return { applied, requested: requestedValue, source: capability.source, adjusted: true, reason }
}

/**
 * Serialize the first attempt for a deployment. Concurrent turns would
 * otherwise all send the unproven value before any of them learns it is wrong.
 */
export async function withEffortProbe<T>(
  provider: unknown,
  model: unknown,
  effort: unknown,
  run: (effort: string) => Promise<T>,
): Promise<T> {
  const key = keyOf(provider, model)
  const existing = probes.get(key)
  if (existing) return existing.then(() => run(effort as string)) as Promise<T>

  const decision = decideReasoningEffort(provider, model, effort)
  const task = run(decision.applied)
    .then(result => {
      if (decision.applied) noteSupported(provider, model, decision.applied)
      return result
    })
    .catch(error => {
      if (decision.applied && isReasoningEffortUnsupported(error)) {
        noteUnsupported(provider, model, decision.applied)
      }
      throw error
    })
    .finally(() => {
      probes.delete(key)
    })

  probes.set(key, task.then(() => ''))
  return task
}

/**
 * For paths that own the provider call, so a rejection can be retried. The
 * fallback target comes from the capability table rather than "one rung down",
 * so a table that stops at medium jumps straight there.
 */
export async function withReasoningEffortFallback<T>(
  attempt: (effort: string) => Promise<T>,
  options: { provider?: unknown; model?: unknown; effort: unknown; maxAttempts?: number },
): Promise<T> {
  const requested = typeof options.effort === 'string' ? options.effort.trim().toLowerCase() : ''
  if (!requested) return attempt('')

  const limit = Math.max(1, options.maxAttempts ?? 3)
  // Fail closed: an unknown deployment sends no effort at all rather than the
  // requested one, which is exactly the request that would fail the turn.
  const supported = capabilityFor(options.provider, options.model).supported
  let current: ReasoningEffort | '' = pickSupported(requested, supported)
  let lastError: unknown

  for (let i = 0; i < limit; i += 1) {
    try {
      const result = await attempt(current)
      if (current) noteSupported(options.provider, options.model, current)
      return result
    } catch (error) {
      lastError = error
      if (!isReasoningEffortUnsupported(error)) throw error
      noteUnsupported(options.provider, options.model, current)
      const byTable = pickSupported(requested, capabilityFor(options.provider, options.model).supported)
      current = byTable || stepDown(current)
      if (!current) throw error
    }
  }
  throw lastError
}

export { REASONING_EFFORT_LADDER, ceilingIndex }

registerEffortCapabilityHooks({ hydrate: hydrateEntry, persist: flushNow })
