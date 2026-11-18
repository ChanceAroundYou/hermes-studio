import { randomUUID } from 'node:crypto'
import { logger } from '../public/logging'

type RunState = { isWorking: boolean; isAborting?: boolean; activeRunMarker?: string; responseRun?: { runMarker?: string } }
type Binding = { sessionId: string; profile: string; resolve: () => RunState | undefined; runId?: string }
type Reason = 'response' | 'dismissed' | 'timeout' | 'cancelled' | 'aborted'
type Result = { clarify_id: string; response: string; reason: Reason }
type Pending = { contextId: string; sessionId: string; finish: (reason: Reason, response?: string) => void }
export const CLARIFICATION_TIMEOUT_MS = 300_000

/**
 * Why a prompt was refused.
 *
 * Every refusal used to be a bare 409 carrying only a human sentence, so a
 * caller could not tell "the turn is gone" from "this profile is not the one
 * that asked" from "the request was cancelled" -- and nothing was written down
 * either, so a prompt that never appeared left no trace at all.
 */
export type ClarificationErrorCode =
  | 'invalid_request'
  | 'context_unknown'
  | 'context_wrong_profile'
  | 'context_no_active_turn'
  | 'request_aborted'

export class ClarificationError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: ClarificationErrorCode = 'invalid_request',
  ) {
    super(message)
  }
}

function parseQuestion(input: Record<string, unknown>) {
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 4000) {
    throw new ClarificationError('question must contain 1 to 4000 characters')
  }
  if (input.choices !== undefined && (!Array.isArray(input.choices) || input.choices.length > 20
    || input.choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 500))) {
    throw new ClarificationError('choices must contain at most 20 non-empty strings of at most 500 characters')
  }
  return { question: input.question.trim(), choices: [...new Set(((input.choices || []) as string[]).map(choice => choice.trim()))] }
}

/** MCP interactions are capabilities for one live turn, never caller-selected sessions. */
export class ClarificationRuns {
  private readonly bindings = new Map<string, Binding>()
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly publish: (sessionId: string, event: string, payload: Record<string, unknown>) => void) {}

  /**
   * Bind a turn's interaction context.
   *
   * This deliberately does not settle the session's outstanding prompts: a
   * prompt belongs to the turn that raised it, and that turn's terminal event
   * (`finishSession` with its own contextId) is what ends it. Sweeping here is
   * what cancelled a still-open question the moment the next turn started.
   */
  begin(contextId: string, sessionId: string, profile: string, resolve: Binding['resolve']): void {
    this.bindings.set(contextId, { sessionId, profile, resolve })
  }

  /** Record the refusal, then refuse. Nothing here is silent. */
  private refuse(
    code: ClarificationErrorCode,
    message: string,
    detail: { contextId: string; profile: string; sessionId?: string },
  ): never {
    logger.warn(
      { code, contextId: detail.contextId, sessionId: detail.sessionId, profile: detail.profile },
      '[clarification-runs] refused an interaction request',
    )
    throw new ClarificationError(message, 409, code)
  }

  private active(contextId: string, profile: string) {
    const binding = this.bindings.get(contextId)
    if (!binding) {
      this.refuse('context_unknown', 'Interaction context is unavailable or has expired', { contextId, profile })
    }
    if (binding.profile !== profile) {
      this.refuse('context_wrong_profile', 'Interaction context belongs to another profile', {
        contextId, profile, sessionId: binding.sessionId,
      })
    }
    const state = binding.resolve()
    const runId = state?.activeRunMarker || state?.responseRun?.runMarker
    if (!state?.isWorking || state.isAborting || !runId || (binding.runId && binding.runId !== runId)) {
      this.refuse('context_no_active_turn', 'Interaction context has no active turn', {
        contextId, profile, sessionId: binding.sessionId,
      })
    }
    binding.runId = runId
    return { binding, runId }
  }

  request(contextId: string, profile: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const { binding, runId } = this.active(contextId, profile)
    const { question, choices } = parseQuestion(input)
    if (signal?.aborted) {
      this.refuse('request_aborted', 'Interaction request was cancelled', {
        contextId, profile, sessionId: binding.sessionId,
      })
    }
    // A session may wait on several prompts at once. Rejecting the second one
    // made the question that arrived while the user was reading the first
    // undeliverable, and the turn that asked it stalled until its timeout.
    const clarifyId = randomUUID()
    return new Promise((resolve, reject) => {
      const finish = (reason: Reason, response = '') => {
        if (!this.pending.delete(clarifyId)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        try {
          this.publish(binding.sessionId, 'clarify.resolved', {
            event: 'clarify.resolved', run_id: runId, clarify_id: clarifyId, resolved: true, reason,
            profile: binding.profile,
          })
        } catch (error) { reject(error); return }
        resolve({ clarify_id: clarifyId, response, reason })
      }
      const onAbort = () => finish('cancelled')
      const timer = setTimeout(() => finish('timeout'), CLARIFICATION_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(clarifyId, { contextId, sessionId: binding.sessionId, finish })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.publish(binding.sessionId, 'clarify.requested', {
          event: 'clarify.requested', run_id: runId, clarify_id: clarifyId, question,
          choices: choices.length ? choices : null, timeout_ms: CLARIFICATION_TIMEOUT_MS,
          remaining_timeout_ms: CLARIFICATION_TIMEOUT_MS, requested_at: Date.now(),
          // The turn knows which profile it belongs to. Without it the delivery
          // room was inferred from `sessionMap` and then the stored session, and
          // a session that was not in either yet fell through to `default`.
          profile: binding.profile,
        })
      } catch (error) {
        this.pending.delete(clarifyId)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
  }

  respond(sessionId: string, clarifyId: string, response = ''): { handled: boolean; resolved: boolean } {
    const pending = this.pending.get(clarifyId)
    if (!pending) return { handled: false, resolved: false }
    if (pending.sessionId !== sessionId) return { handled: true, resolved: false }
    const binding = this.bindings.get(pending.contextId)
    try { this.active(pending.contextId, binding?.profile || '') }
    catch {
      pending.finish('cancelled')
      return { handled: true, resolved: false }
    }
    pending.finish(response ? 'response' : 'dismissed', response)
    return { handled: true, resolved: true }
  }

  /**
   * End the prompts a session is waiting on.
   *
   * `reason` distinguishes "the turn ended" (`cancelled`) from "the user stopped
   * the run" (`aborted`): the card says something different in each case, and
   * conflating them told the user their question had been cancelled by the agent
   * when in fact they had stopped it themselves.
   */
  finishSession(sessionId: string, contextId?: string, reason: Reason = 'cancelled'): void {
    for (const [id, binding] of this.bindings) {
      if (binding.sessionId === sessionId && (!contextId || id === contextId)) this.bindings.delete(id)
    }
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId && (!contextId || pending.contextId === contextId)) pending.finish(reason)
    }
  }
}

export function clarificationTurnInstruction(contextId: string): string {
  return `<studio_interaction_context>\nWhen a missing user decision materially affects the task, call ekko_studio_clarify from the same ekko-studio-interaction MCP server used for task cards, with a concise question and optional choices. This tool displays the existing Studio/App question UI and waits for the user's response. Use it instead of terminal input or native interactive tools unavailable in headless mode. If tools are deferred, search for ekko-studio-interaction / clarify and use the discovered tool name. A timeout, dismissal, or cancellation is not user approval. Never use it from delegated subagents or background tasks.\nCurrent turn context_id="${contextId}". Use only this interaction context, never an id from earlier messages.\n</studio_interaction_context>`
}
