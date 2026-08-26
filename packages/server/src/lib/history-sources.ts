/**
 * History source visibility rules — single source of truth shared by the
 * controller layer (sessions.ts) and the db layer (sessions-db.ts).
 *
 * Lives in lib/ (not controllers/) because sessions-db imports these
 * predicates; keeping them here avoids a db -> controller circular import.
 */

// Sources that are system / task artifacts rather than human-initiated
// conversations. They live in state.db (cron jobs, delegated subagent runs)
// but don't belong in the Studio history list — the list should be dominated
// by imported / human conversations (same philosophy as "import to WebUI only
// shows selected sessions").
const EXCLUDED_HISTORY_SOURCES = new Set(['cron', 'subagent'])

/**
 * Hermes History list policy (blacklist): everything is visible except
 * internal runtime sources. feishu / tui / telegram / cli / api_server /
 * coding_agent all appear in History.
 */
export function isHermesHistorySessionSource(source?: string | null): boolean {
  return source !== 'global_agent' && source !== 'workflow' && source !== 'group_chat'
}

export function isHistoryVisibleSource(source?: string | null): boolean {
  return isHermesHistorySessionSource(source) && !EXCLUDED_HISTORY_SOURCES.has(source || '')
}
