/**
 * Session Deleter — periodically drains pending session deletes.
 *
 * Reads from gc_pending_session_deletes table, executes deletion via
 * Hermes CLI, tracks failures (max 3 attempts), and auto-drains on
 * a timer (across ALL profiles — parallel-profile design).
 */
import { getDb } from '../../db/index'
import { deleteSession as hermesDeleteSession } from './hermes-cli'
import { listProfileNamesFromDisk } from './hermes-profile'
import { logger } from '../logger'

const MAX_ATTEMPTS = 3
const DRAIN_INTERVAL_MS = 300_000

export class SessionDeleter {
  private static _instance: SessionDeleter | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  static getInstance(): SessionDeleter {
    if (!SessionDeleter._instance) {
      SessionDeleter._instance = new SessionDeleter()
    }
    return SessionDeleter._instance
  }

  /** Start periodic drain for ALL profiles (parallel-profile design). */
  startAll(): void {
    this.stop()
    logger.info('[SessionDeleter] started (all profiles), interval=%dms', DRAIN_INTERVAL_MS)
    // Drain immediately on start, then on interval
    void this.drainAll().catch(() => {})
    this.timer = setInterval(() => {
      void this.drainAll().catch(() => {})
    }, DRAIN_INTERVAL_MS)
  }

  /** Drain all profiles. */
  async drainAll(): Promise<void> {
    const profiles = listProfileNamesFromDisk()
    for (const profile of profiles) {
      try {
        await this.drain(profile)
      } catch (err: any) {
        logger.warn('[SessionDeleter] drain failed for profile=%s: %s', profile, err?.message || err)
      }
    }
  }

  /** Stop periodic drain */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Drain pending deletes for a specific profile */
  async drain(profile: string): Promise<{ deleted: string[]; skipped: string[]; failed: string[] }> {
    const db = getDb()
    if (!db) return { deleted: [], skipped: [], failed: [] }

    const now = Date.now()
    const rows = db.prepare(`
      SELECT session_id, profile_name, status, attempt_count, last_error
      FROM gc_pending_session_deletes
      WHERE profile_name = ? AND status = 'pending' AND attempt_count < ? AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT 50
    `).all(profile, MAX_ATTEMPTS, now) as Array<{
      session_id: string
      profile_name: string
      status: string
      attempt_count: number
      last_error: string | null
    }>

    if (rows.length === 0) return { deleted: [], skipped: [], failed: [] }

    const deleted: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    for (const row of rows) {
      try {
        const ok = await hermesDeleteSession(row.session_id)
        if (ok) {
          db.prepare('DELETE FROM gc_pending_session_deletes WHERE session_id = ?').run(row.session_id)
          db.prepare('DELETE FROM gc_session_profiles WHERE session_id = ?').run(row.session_id)
          deleted.push(row.session_id)
        } else {
          skipped.push(row.session_id)
        }
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        db.prepare(
          `UPDATE gc_pending_session_deletes
           SET status = 'pending', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?, next_attempt_at = ?
           WHERE session_id = ?`,
        ).run(msg, now, now + 60_000, row.session_id)
        failed.push(row.session_id)
        logger.warn('[SessionDeleter] failed to delete %s (attempt %d): %s', row.session_id, row.attempt_count + 1, msg)
      }
    }

    if (deleted.length || failed.length) {
      logger.info('[SessionDeleter] profile=%s: deleted=%d, failed=%d', profile, deleted.length, failed.length)
    }

    return { deleted, skipped, failed }
  }
}
