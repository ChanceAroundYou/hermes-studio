import { randomUUID } from 'node:crypto'
import type { TaskPlanSnapshot } from '../contracts/task-plan'

type PlanUpdate = Pick<TaskPlanSnapshot, 'explanation' | 'plan'>
type TerminalState = Exclude<TaskPlanSnapshot['execution_state'], 'running'>
type RunState = { isWorking: boolean; isAborting?: boolean; runId?: string; activeRunMarker?: string; responseRun?: { runMarker?: string } }

/** Turn markers identify one turn. Coding-agent group runs only set runId. */
function activeTurnId(state: RunState | undefined): string {
  return state?.activeRunMarker || state?.responseRun?.runMarker || state?.runId || ''
}
type Binding = { contextId: string; sessionId: string; profile: string; sequence: number; resolve: () => RunState | undefined; snapshot?: TaskPlanSnapshot; publish?: (snapshot: TaskPlanSnapshot) => void }


export class TaskPlanError extends Error {
  constructor(message: string, public readonly status = 400) { super(message) }
}

export function parseTaskPlanUpdate(input: Record<string, unknown>): PlanUpdate {
  if (!Array.isArray(input.plan) || input.plan.length < 1 || input.plan.length > 30) {
    throw new TaskPlanError('plan must contain 1 to 30 steps')
  }
  if (input.explanation !== undefined && (typeof input.explanation !== 'string' || input.explanation.length > 1000)) {
    throw new TaskPlanError('explanation must be a string of at most 1000 characters')
  }
  const ids = new Set<string>()
  let inProgress = 0
  const plan = input.plan.map((value): TaskPlanSnapshot['plan'][number] => {
    if (!value || typeof value !== 'object') throw new TaskPlanError('Invalid plan step')
    const { id, step, status } = value
    if (typeof id !== 'string' || !id.trim() || id.trim().length > 100 || ids.has(id.trim())) {
      throw new TaskPlanError('Step ids must be unique non-empty strings of at most 100 characters')
    }
    if (typeof step !== 'string' || !step.trim() || step.trim().length > 200) {
      throw new TaskPlanError('Step text must contain 1 to 200 characters')
    }
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new TaskPlanError('Invalid step status')
    if (status === 'in_progress' && ++inProgress > 1) throw new TaskPlanError('Only one step can be in_progress')
    ids.add(id.trim())
    return { id: id.trim(), step: step.trim(), status }
  })
  return { ...(input.explanation !== undefined ? { explanation: input.explanation as string } : {}), plan }
}

/** Per-turn capabilities: an old MCP call cannot write into a later turn or another profile. */
export class TaskPlanRuns {
  private readonly bindings = new Map<string, Binding>()
  // A session may hold several live contexts concurrently (begin() seeds one
  // per turn; a new turn does NOT settle an earlier one that is still active,
  // because a browser turn can legitimately overlap its successor and both may
  // still receive plan writes).
  private readonly sessions = new Map<string, Set<string>>()
  private sequence = 0

  constructor(
    private readonly commit: (snapshot: TaskPlanSnapshot) => void,
    private readonly publish: (sessionId: string, snapshot: TaskPlanSnapshot) => void,
  ) {}

  begin(sessionId: string, profile: string, resolve: Binding['resolve'], publish?: Binding['publish']): string {
    const contextId = randomUUID()
    const binding: Binding = { contextId, sessionId, profile, resolve, publish, sequence: ++this.sequence }
    this.bindings.set(contextId, binding)
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Set())
    this.sessions.get(sessionId)!.add(contextId)
    return contextId
  }

  /** True when `binding` still accepts plan writes: a live, in-flight turn. */
  private writable(binding: Binding): boolean {
    const state = binding.resolve()
    const runId = state?.activeRunMarker || state?.responseRun?.runMarker
    return !!state?.isWorking && !state.isAborting && !!runId
  }

  /**
   * True when a newer turn of the same session has taken over. Such a binding
   * is superseded, not finished: it may still be readable, but a write aimed at
   * it must be redirected to the newer turn rather than accepted as its own.
   */
  private superseded(binding: Binding): boolean {
    for (const candidate of this.sessions.get(binding.sessionId) || []) {
      const other = this.bindings.get(candidate)
      if (other && other.sequence > binding.sequence) return true
    }
    return false
  }

  /**
   * Resolve the binding that may accept this write, in priority order. The
   * profile — derived server-side from the JWT, never from the request body —
   * is the security boundary: no layer can reach a different profile.
   *
   *   1. the exact `contextId`, if it is this profile's and not superseded by a
   *      newer turn of its own session;
   *   2. the claimed SESSION's own current binding — this is how an id from an
   *      earlier turn of that session self-heals onto the turn that now owns
   *      the card. A foreign or unknown session is still rejected;
   *   3. the profile's active context, ONLY when the caller claimed neither a
   *      context nor a session, and that profile has exactly one writable turn.
   *
   * Level 3 is the escape hatch for a CLI / gateway MCP server, which is
   * spawned once per profile and never receives a Studio context or session
   * id — for it an omitted id is the normal case, not a spoof. It is
   * deliberately narrow: with several turns in flight (two open sessions, or a
   * turn overlapping its successor) it refuses rather than guessing which card
   * the caller means. A caller that named a specific id is judged by layers 1
   * and 2 only: they can never route by profile alone.
   */
  private resolveBinding(contextId: string, profile: string, sessionId?: string): Binding | undefined {
    if (contextId) {
      const binding = this.bindings.get(contextId)
      if (binding && binding.profile === profile && !this.superseded(binding)) return binding
    }

    if (sessionId) {
      const candidates = [...(this.sessions.get(sessionId) || [])]
        .map(id => this.bindings.get(id))
        .filter((b): b is Binding => !!b && b.profile === profile && !this.superseded(b))
      if (candidates.length) return candidates[candidates.length - 1]
    }

    // Only a caller with nothing to claim may be routed by the profile alone.
    return contextId || sessionId ? undefined : this.unambiguousActive(profile)
  }

  /** The profile's writable context, or undefined when ambiguous or none. */
  private unambiguousActive(profile: string): Binding | undefined {
    let only: Binding | undefined
    for (const candidate of this.bindings.values()) {
      if (candidate.profile !== profile || !this.writable(candidate)) continue
      if (only) return undefined
      only = candidate
    }
    return only
  }

  /**
   * Update a turn's plan. A missing, stale, or reused `contextId` self-heals
   * through `resolveBinding` instead of failing the write.
   */
  update(contextId: string, profile: string, input: Record<string, unknown>, sessionId?: string): TaskPlanSnapshot {
    // A context id issued by a DIFFERENT profile is always a hard failure — the
    // profile comes from the authenticated JWT, never from the request body.
    // An id from this profile that is stale or never used may self-heal.
    const named = contextId ? this.bindings.get(contextId) : undefined
    if (named && named.profile !== profile) {
      throw new TaskPlanError('Task plan context is unavailable or has expired', 409)
    }
    const binding = this.resolveBinding(contextId, profile, sessionId)
    if (!binding) throw new TaskPlanError('Task plan context is unavailable or has expired', 409)
    const state = binding.resolve()
    const runId = activeTurnId(state)
    if (!state?.isWorking || state.isAborting || !runId || (binding.snapshot && binding.snapshot.run_id !== runId)) {
      throw new TaskPlanError('Task plan context has no active turn', 409)
    }
    const update = parseTaskPlanUpdate(input)
    const now = Date.now()
    const snapshot: TaskPlanSnapshot = {
      ...update, session_id: binding.sessionId, run_id: runId, plan_id: `mcp:${binding.contextId}`,
      revision: (binding.snapshot?.revision || 0) + 1, execution_state: 'running',
      created_at: binding.snapshot?.created_at ?? now, updated_at: now,
    }
    this.commit(snapshot)
    binding.snapshot = snapshot
    binding.publish ? binding.publish(snapshot) : this.publish(binding.sessionId, snapshot)
    return structuredClone(snapshot)
  }

  isActive(contextId: string, profile: string): boolean {
    const binding = this.bindings.get(contextId)
    if (!binding || binding.profile !== profile) return false
    const state = binding.resolve()
    const runId = activeTurnId(state)
    return Boolean(state?.isWorking && !state.isAborting && runId
      && (!binding.snapshot || binding.snapshot.run_id === runId))
  }

  activeSnapshots(): Array<{ profile: string; snapshot: TaskPlanSnapshot }> {
    const result: Array<{ profile: string; snapshot: TaskPlanSnapshot }> = []
    for (const binding of this.bindings.values()) {
      const state = binding.resolve(), snapshot = binding.snapshot
      if (binding.publish || !snapshot || snapshot.execution_state !== 'running' || !state?.isWorking || state.isAborting) continue
      if (activeTurnId(state) !== snapshot.run_id) continue
      result.push({ profile: binding.profile, snapshot: structuredClone(snapshot) })
    }
    return result.sort((a, b) => b.snapshot.updated_at - a.snapshot.updated_at)
  }

  finish(contextId: string, executionState: TerminalState): void {
    const binding = this.bindings.get(contextId)
    if (!binding) return
    this.bindings.delete(contextId)
    this.sessions.get(binding.sessionId)?.delete(contextId)
    if (!binding.snapshot) return
    const snapshot: TaskPlanSnapshot = {
      ...binding.snapshot, revision: binding.snapshot.revision + 1, execution_state: executionState,
      updated_at: Date.now(),
      plan: binding.snapshot.plan.map(step => ({ ...step, status: step.status === 'in_progress' ? 'pending' : step.status })),
    }
    this.commit(snapshot)
    binding.publish ? binding.publish(snapshot) : this.publish(binding.sessionId, snapshot)
  }

  finishSession(sessionId: string, state: TerminalState): void {
    for (const contextId of [...(this.sessions.get(sessionId) || new Set<string>())]) {
      this.finish(contextId, state)
    }
    this.sessions.delete(sessionId)
  }

}

export function taskPlanRunInstruction(): string {
  return `For multi-step work, maintain the user's Studio task card with ekko_studio_update_plan from the dedicated ekko-studio-interaction MCP server. Call the tool directly; it is not inside ekko_studio_use_toolset. If tools are deferred, search for ekko-studio-interaction / update_plan and use the exact discovered tool name (including its MCP prefix). The latest input supplies the current context_id; never reuse a context from history. Send the complete ordered plan each time, with stable step ids and statuses pending, in_progress, or completed; at most one step may be in_progress. Create the plan before substantial work and update it as work advances. Mark steps completed only after verification. Skip planning for simple one-step requests unless the user explicitly asks for a plan or task card. Prefer this shared tool over native todo/planning tools so progress appears in Studio and App.`
}

/** Attach changing run metadata to the latest input, outside cached system prompts. */
export function taskPlanTurnInstruction(contextId: string): string {
  return `<studio_task_plan_context>\n${taskPlanRunInstruction()}\nCurrent turn context_id="${contextId}". This supersedes all older task-plan contexts and discovery instructions, including cached system instructions.\n</studio_task_plan_context>`
}

export function withTaskPlanTurnContext<T extends { type: string; text?: string }>(message: string | T[], contextId?: string): string | Array<T | { type: 'text'; text: string }> {
  if (!contextId) return message
  const text = taskPlanTurnInstruction(contextId)
  return typeof message === 'string' ? `${message}\n\n${text}` : [...message, { type: 'text', text }]
}
