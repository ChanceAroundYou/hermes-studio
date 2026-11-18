import {
  listPendingInteractions,
  resolvePendingInteraction,
  resolvePendingInteractionsForOwner,
  savePendingInteraction,
} from '../../repositories/pending-interaction-store'
import type { PendingInteractionReason, PendingInteractionSnapshot } from '../../contracts/pending-interaction'

/**
 * Room prompts, mirrored into the shared pending-interaction store.
 *
 * The group chat keeps its own in-memory route map, because the answer has to
 * travel back to the agent that is still waiting. That map cannot be serialized
 * and dies with the process, so before this the room's prompt had no snapshot to
 * reconcile against: a reload lost it, and anyone not sitting in the room never
 * learned about it.
 *
 * Only display state is stored. The reply path stays the in-memory route, so a
 * row recovered after a restart is never silently answerable.
 */
export interface RoomClarifyInput {
  roomId: string
  profile: string
  clarifyId: string
  question: string
  choices: string[] | null
  runId: string
  timeoutMs: number
  requestedAt: number
}

/** Record (or refresh) one room's prompt. Re-asking the same id updates in place. */
export function persistRoomClarify(input: RoomClarifyInput): void {
  savePendingInteraction({
    scope: 'room',
    owner_id: input.roomId,
    interaction_id: input.clarifyId,
    kind: 'clarify',
    status: 'pending',
    profile: input.profile,
    question: input.question,
    choices: input.choices,
    run_id: input.runId || null,
    // A room prompt is not owned by a session turn, so there is no context to
    // settle it by.
    context_id: null,
    deadline: input.requestedAt + input.timeoutMs,
    created_at: input.requestedAt,
    resolved_at: null,
    resolved_reason: null,
  })
}

/** Settle one room prompt. False means it was already terminal, so nothing changed. */
export function settleRoomClarify(roomId: string, clarifyId: string, reason: PendingInteractionReason): boolean {
  return resolvePendingInteraction('room', roomId, clarifyId, reason)
}

/** Settle every prompt still open in one room (room cleared, agent interrupted). */
export function settleRoomClarifies(roomId: string, reason: PendingInteractionReason): number {
  return resolvePendingInteractionsForOwner('room', roomId, reason)
}

/**
 * What one room still has open, shaped for the group client.
 *
 * `owner_id` is the room id, which is what the group payload indexes by, so the
 * caller matches on the field it already uses rather than a borrowed session id.
 */
export function listRoomClarifies(roomId: string): PendingInteractionSnapshot[] {
  return listPendingInteractions({ scope: 'room', ownerIds: [roomId] })
}
