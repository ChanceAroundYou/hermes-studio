/**
 * A pending interaction is a question or approval the agent is blocked on.
 *
 * Unlike a task plan it is *not* owned by one session: a group chat asks from a
 * room and a mobile device asks over a device channel. `scope` + `owner_id`
 * together identify the thing that owns the interaction, so the same
 * `interaction_id` may legitimately exist once per scope.
 *
 * Only what the card needs to render is persisted. The server-side `finish`
 * callback is a live closure and cannot be stored, so a row recovered after a
 * restart is always terminal (`expired`) — never silently answerable.
 */
export const PENDING_INTERACTION_SCOPES = ['session', 'room', 'device'] as const
export type PendingInteractionScope = (typeof PENDING_INTERACTION_SCOPES)[number]

export const PENDING_INTERACTION_KINDS = ['clarify', 'approval'] as const
export type PendingInteractionKind = (typeof PENDING_INTERACTION_KINDS)[number]

export const PENDING_INTERACTION_STATUSES = ['pending', 'resolved', 'expired', 'cancelled', 'aborted'] as const
export type PendingInteractionStatus = (typeof PENDING_INTERACTION_STATUSES)[number]

export const PENDING_INTERACTION_REASONS = ['response', 'dismissed', 'timeout', 'cancelled', 'aborted', 'expired'] as const
export type PendingInteractionReason = (typeof PENDING_INTERACTION_REASONS)[number]

/** The status a terminal reason settles into. Approval refusals are still answers. */
export const PENDING_INTERACTION_STATUS_BY_REASON: Record<PendingInteractionReason, PendingInteractionStatus> = {
  response: 'resolved',
  dismissed: 'resolved',
  timeout: 'expired',
  expired: 'expired',
  cancelled: 'cancelled',
  aborted: 'aborted',
}

export interface PendingInteractionSnapshot {
  /** `session` | `room` | `device` — which carrier the interaction belongs to. */
  scope: PendingInteractionScope
  /** session id for `session`/`device`, room id for `room`. */
  owner_id: string
  interaction_id: string
  kind: PendingInteractionKind
  status: PendingInteractionStatus
  profile: string
  question: string
  choices: string[] | null
  run_id: string | null
  context_id: string | null
  /** Absolute epoch ms at which the prompt expires; the wire carries the
   *  remaining duration instead, so a clock difference cannot skew a countdown. */
  deadline: number | null
  created_at: number
  resolved_at: number | null
  resolved_reason: PendingInteractionReason | null
}
