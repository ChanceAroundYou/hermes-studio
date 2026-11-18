import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { PENDING_INTERACTIONS_TABLE } from '../infrastructure/database/schemas'
import {
  PENDING_INTERACTION_STATUS_BY_REASON,
  type PendingInteractionReason,
  type PendingInteractionScope,
  type PendingInteractionSnapshot,
} from '../contracts/pending-interaction'

export interface PendingInteractionQuery {
  scope?: PendingInteractionScope
  /** Empty array means "none are visible", not "no filter". */
  ownerIds?: string[]
  /** Empty array means "none are visible", not "no filter". */
  profiles?: string[]
  includeResolved?: boolean
}

type Row = {
  scope: string
  owner_id: string
  interaction_id: string
  kind: string
  status: string
  profile: string
  question: string
  choices: string | null
  run_id: string | null
  context_id: string | null
  deadline: number | null
  created_at: number
  resolved_at: number | null
  resolved_reason: string | null
}

function toSnapshot(row: Row): PendingInteractionSnapshot {
  return {
    scope: row.scope as PendingInteractionSnapshot['scope'],
    owner_id: row.owner_id,
    interaction_id: row.interaction_id,
    kind: row.kind as PendingInteractionSnapshot['kind'],
    status: row.status as PendingInteractionSnapshot['status'],
    profile: row.profile,
    question: row.question,
    choices: row.choices === null ? null : JSON.parse(row.choices) as string[],
    run_id: row.run_id,
    context_id: row.context_id,
    deadline: row.deadline,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_reason: row.resolved_reason as PendingInteractionReason | null,
  }
}

/** Persist what the card needs. A re-publish of the same interaction updates in place. */
export function savePendingInteraction(item: PendingInteractionSnapshot): void {
  if (!isSqliteAvailable()) throw new Error('Pending interaction storage is unavailable.')
  getDb()!.prepare(`
    INSERT INTO ${PENDING_INTERACTIONS_TABLE}
      (scope, owner_id, interaction_id, kind, status, profile, question, choices,
       run_id, context_id, deadline, created_at, resolved_at, resolved_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, owner_id, interaction_id) DO UPDATE SET
      kind = excluded.kind,
      status = excluded.status,
      profile = excluded.profile,
      question = excluded.question,
      choices = excluded.choices,
      run_id = excluded.run_id,
      context_id = excluded.context_id,
      deadline = excluded.deadline,
      resolved_at = excluded.resolved_at,
      resolved_reason = excluded.resolved_reason
  `).run(
    item.scope, item.owner_id, item.interaction_id, item.kind, item.status, item.profile,
    item.question, item.choices === null ? null : JSON.stringify(item.choices),
    item.run_id, item.context_id, item.deadline, item.created_at, item.resolved_at, item.resolved_reason,
  )
}

/**
 * Settle one interaction. Returns false when it was already terminal or unknown,
 * so a caller can tell "I answered it" apart from "it was already gone".
 */
export function resolvePendingInteraction(
  scope: PendingInteractionScope,
  ownerId: string,
  interactionId: string,
  reason: PendingInteractionReason,
): boolean {
  if (!isSqliteAvailable()) return false
  const result = getDb()!.prepare(`
    UPDATE ${PENDING_INTERACTIONS_TABLE}
    SET status = ?, resolved_at = ?, resolved_reason = ?
    WHERE scope = ? AND owner_id = ? AND interaction_id = ? AND status = 'pending'
  `).run(PENDING_INTERACTION_STATUS_BY_REASON[reason], Date.now(), reason, scope, ownerId, interactionId)
  return result.changes > 0
}

/** Settle every still-pending interaction owned by one carrier (a session or a room). */
export function resolvePendingInteractionsForOwner(
  scope: PendingInteractionScope,
  ownerId: string,
  reason: PendingInteractionReason,
): number {
  if (!isSqliteAvailable()) return 0
  const result = getDb()!.prepare(`
    UPDATE ${PENDING_INTERACTIONS_TABLE}
    SET status = ?, resolved_at = ?, resolved_reason = ?
    WHERE scope = ? AND owner_id = ? AND status = 'pending'
  `).run(PENDING_INTERACTION_STATUS_BY_REASON[reason], Date.now(), reason, scope, ownerId)
  return Number(result.changes)
}

export function listPendingInteractions(query: PendingInteractionQuery = {}): PendingInteractionSnapshot[] {
  if (!isSqliteAvailable()) return []
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (!query.includeResolved) clauses.push(`status = 'pending'`)
  if (query.scope) {
    clauses.push('scope = ?')
    params.push(query.scope)
  }
  if (query.ownerIds) {
    if (!query.ownerIds.length) return []
    clauses.push(`owner_id IN (${query.ownerIds.map(() => '?').join(', ')})`)
    params.push(...query.ownerIds)
  }
  if (query.profiles) {
    if (!query.profiles.length) return []
    clauses.push(`profile IN (${query.profiles.map(() => '?').join(', ')})`)
    params.push(...query.profiles)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = getDb()!.prepare(
    `SELECT * FROM ${PENDING_INTERACTIONS_TABLE}${where} ORDER BY created_at ASC, interaction_id ASC`,
  ).all(...params) as Row[]
  return rows.map(toSnapshot)
}

/**
 * A live `finish` closure cannot outlive the process. Anything still pending at
 * startup belongs to a turn that no longer exists, so it must not come back as
 * an answerable card.
 */
export function expireOrphanedPendingInteractions(): number {
  if (!isSqliteAvailable()) return 0
  const result = getDb()!.prepare(`
    UPDATE ${PENDING_INTERACTIONS_TABLE}
    SET status = 'expired', resolved_at = ?, resolved_reason = 'expired'
    WHERE status = 'pending'
  `).run(Date.now())
  return Number(result.changes)
}
