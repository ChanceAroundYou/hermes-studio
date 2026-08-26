/**
 * Session Message Sync — reconcile webui DB mirror against the Hermes CLI
 * state.db for live CLI/Feishu/cron sessions.
 *
 * Problem: the webui DB keeps an import-time snapshot of a session that also
 * lives in the Hermes Agent state.db. After the CLI keeps writing, the webui
 * mirror goes stale (e.g. stuck at 03:13 while state.db is at 13:37), so a
 * live CLI session renders old messages.
 *
 * This service copies messages from state.db (authoritative) into the webui
 * mirror, ONE-WAY, filling gaps only. It NEVER deletes or overwrites webui
 * state and NEVER writes back to state.db. Dedup key is (session_id, role,
 * content) so re-running is idempotent — it won't duplicate and it won't
 * remove webui-only rows (e.g. /compress command entries).
 */
import { getDb } from '../../db/index'
import {
  getSessionDetailPaginatedFromDbWithProfile,
  getExactSessionDetailFromDbWithProfile,
} from '../../db/hermes/sessions-db'
import { listProfileNamesFromDisk } from './hermes-profile'
import { logger } from '../logger'

const DEFAULT_INTERVAL_MS = 15 * 60_000 // 15 min
const SYNC_WINDOW_HOURS = 24 // only touch sessions active in last 24h
// 15s debounce for "on session open" triggers
const DEBOUNCE_MS = 15_000
// Tail-window reconciliation: state.db is append-only per session, so gaps
// only appear at the tail. Reading the newest SYNC_TAIL_LIMIT rows from both
// sides is sufficient; a mid-history gap (should not happen for imported
// snapshots) is covered by the on-session-open debounced sync.
const SYNC_TAIL_LIMIT = 500

interface SyncResult {
  scanned: number
  missing: number
  inserted: number
  skipped: number
}

export class SessionMessageSync {
  private static _instance: SessionMessageSync | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private activeProfile: string = 'default'
  // Set by stop() so an in-flight sweep loop aborts instead of running to
  // completion after the service was asked to stop.
  private stopped = false

  static getInstance(): SessionMessageSync {
    if (!SessionMessageSync._instance) {
      SessionMessageSync._instance = new SessionMessageSync()
    }
    return SessionMessageSync._instance
  }

  /** Start the 15-minute periodic sweep. */
  start(profile: string): void {
    this.activeProfile = profile
    this.stopped = false
    this.stop()
    logger.info('[SessionMessageSync] started, profile=%s, interval=%dms', profile, DEFAULT_INTERVAL_MS)
    // Sweep immediately on start, then on interval.
    this.sweepActive(true).catch(() => {})
    this.timer = setInterval(() => {
      this.sweepActive(true).catch((err) => logger.warn('[SessionMessageSync] sweep failed: %s', err?.message || err))
    }, DEFAULT_INTERVAL_MS)
  }

  /** Stop periodic sweep. */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
  }

  /**
   * Debounced "on session open" check. Called when a session detail is
   * fetched; coalesces rapid opens into one sync after 15s of inactivity.
   */
  scheduleSessionSync(sessionId: string): void {
    const prev = this.debounceTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.debounceTimers.delete(sessionId)
      this.syncSession(sessionId).catch((err) =>
        logger.warn('[SessionMessageSync] session sync %s failed: %s', sessionId, (err as any)?.message || err))
    }, DEBOUNCE_MS)
    this.debounceTimers.set(sessionId, t)
  }

  /** Sweep all sessions (optionally filtered to recently active ones). */
  async sweepActive(onlyRecent = true): Promise<SyncResult> {
    const db = getDb()
    if (!db) return { scanned: 0, missing: 0, inserted: 0, skipped: 0 }
    let ids: string[] = []
    if (onlyRecent) {
      const cutoff = Math.floor(Date.now() / 1000) - SYNC_WINDOW_HOURS * 3600
      const rows = db.prepare(
        'SELECT id FROM sessions WHERE last_active >= ?',
      ).all(cutoff) as Array<{ id: string }>
      ids = rows.map((r) => r.id)
    } else {
      const rows = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
      ids = rows.map((r) => r.id)
    }
    let total: SyncResult = { scanned: ids.length, missing: 0, inserted: 0, skipped: 0 }
    for (const id of ids) {
      if (this.stopped) break
      const r = await this.syncSession(id)
      total.missing += r.missing
      total.inserted += r.inserted
      total.skipped += r.skipped
    }
    if (total.inserted > 0) {
      logger.info('[SessionMessageSync] sweep done: scanned=%d inserted=%d', total.scanned, total.inserted)
    }
    return total
  }

  /** Sync one session: fill (session_id, role, content) gaps from state.db. */
  async syncSession(sessionId: string): Promise<SyncResult> {
    const db = getDb()
    if (!db) return { scanned: 1, missing: 0, inserted: 0, skipped: 0 }

    // Find which profile owns this session (webui row, else scan state.dbs).
    let profile = ''
    const row = db.prepare('SELECT profile FROM sessions WHERE id = ?').get(sessionId) as { profile?: string } | undefined
    if (row?.profile) {
      profile = row.profile
    } else {
      for (const p of listProfileNamesFromDisk()) {
        try {
          const found = await getExactSessionDetailFromDbWithProfile(sessionId, p)
          if (found) { profile = p; break }
        } catch { /* skip */ }
      }
    }
    if (!profile) return { scanned: 1, missing: 0, inserted: 0, skipped: 0 }

    // Read state.db authoritative messages for this session.
    let stateDetail: any
    try {
      stateDetail = await getSessionDetailPaginatedFromDbWithProfile(sessionId, profile, 0, SYNC_TAIL_LIMIT)
    } catch (err) {
      logger.warn('[SessionMessageSync] read state.db %s failed: %s', sessionId, (err as any)?.message || err)
      return { scanned: 1, missing: 0, inserted: 0, skipped: 0 }
    }
    if (!stateDetail?.messages?.length) return { scanned: 1, missing: 0, inserted: 0, skipped: 0 }

    const stateMsgs = stateDetail.messages as Array<Record<string, any>>

    // Normalize whitespace before comparing: state.db sometimes contains two
    // rows for the same message that differ only in trailing whitespace or
    // extra newlines (Hermes kernel duplication bug).
    const normalize = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim()

    // Deduplicate state.db rows themselves: the Hermes kernel sometimes
    // writes the same assistant message twice (identical content, timestamps
    // seconds-to-minutes apart, often with a tool interleaved). Only
    // ASSISTANT rows fold within the per-role 300s window. User rows are
    // NEVER collapsed: re-sending the same text after a network failure is a
    // legitimate action and must not be silently dropped.
    const DEDUP_WINDOW_SEC = 300
    const lastByRole = new Map<string, { norm: string; key: string; ts: number }>()
    const dedupedStateMsgs: Array<Record<string, any>> = []
    for (const m of stateMsgs) {
      const raw = m.content ?? ''
      const norm = normalize(raw)
      const key = `${m.role ?? ''}\u0000${norm}`
      const ts = Number(m.timestamp ?? 0)
      if (norm && m.role === 'assistant') {
        const prev = lastByRole.get(String(m.role ?? ''))
        const isDup = !!prev
          && prev.key === key
          && ts >= prev.ts
          && ts - prev.ts < DEDUP_WINDOW_SEC
        if (isDup) continue
        lastByRole.set(String(m.role ?? ''), { norm, key, ts })
      } else {
        // Empty content (e.g. tool-call placeholders) — don't collapse,
        // distinct tool calls must not be merged.
        lastByRole.set(String(m.role ?? ''), { norm: '', key, ts })
      }
      dedupedStateMsgs.push(m)
    }

    // Existing webui keys for this session — tail window only (matches the
    // state.db side; see SYNC_TAIL_LIMIT above).
    // Use count-aware check: if webui already has N copies of same (role,content)
    // and state has M, only insert M-N. Previous Set existence check would hide
    // a legitimate second "继续" forever.
    const existing = db.prepare(
      'SELECT role, content FROM (SELECT role, content, id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id',
    ).all(sessionId, SYNC_TAIL_LIMIT) as Array<{ role: string; content: string }>
    const existingCount = new Map<string, number>()
    for (const r of existing) {
      const k = `${r.role}\u0000${normalize(r.content)}`
      existingCount.set(k, (existingCount.get(k) ?? 0) + 1)
    }
    const seenCount = new Map<string, number>()
    const missingRows: Array<Record<string, any>> = []
    for (const m of dedupedStateMsgs) {
      const key = `${m.role ?? ''}\u0000${normalize(m.content ?? '')}`
      const have = existingCount.get(key) ?? 0
      const seen = seenCount.get(key) ?? 0
      if (seen < have) {
        seenCount.set(key, seen + 1)
        continue
      }
      seenCount.set(key, seen + 1)
      missingRows.push(m)
    }

    if (missingRows.length === 0) return { scanned: 1, missing: 0, inserted: 0, skipped: 0 }

    const insert = db.prepare(`INSERT INTO messages
      (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
       token_count, finish_reason, reasoning, reasoning_details, reasoning_content)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)

    db.exec('BEGIN')
    try {
      for (const m of missingRows) {
        insert.run(
          m.session_id ?? sessionId,
          m.role ?? '',
          m.content ?? '',
          (m.tool_call_id ?? null) as any,
          m.tool_calls != null ? JSON.stringify(m.tool_calls) : null,
          m.tool_name ?? null,
          m.timestamp ?? 0,
          m.token_count ?? null,
          m.finish_reason ?? null,
          m.reasoning ?? null,
          m.reasoning_details ?? null,
          m.reasoning_content ?? null,
        )
      }
      // Update webui mirror metadata.
      db.prepare(`UPDATE sessions SET
          message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
          last_active = (SELECT MAX(timestamp) FROM messages WHERE session_id = ?)
        WHERE id = ?`).run(sessionId, sessionId, sessionId)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    return { scanned: 1, missing: missingRows.length, inserted: missingRows.length, skipped: 0 }
  }
}

export function startSessionMessageSync(profile: string): void {
  SessionMessageSync.getInstance().start(profile)
}
