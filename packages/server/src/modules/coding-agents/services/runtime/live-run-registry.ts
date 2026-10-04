/**
 * Durable record of live coding-agent child processes.
 *
 * The in-memory run manager dies with the server process, so after a restart
 * `abort` finds no run and reports "ignored: no active run" while the agent
 * keeps burning tokens. This registry is the handle that survives: every spawned
 * child records its pid here, and force-stop can kill it from a fresh process.
 *
 * Entries are keyed by session so the abort path can find them without knowing
 * the run id, and every entry carries the owning server pid so a crash cannot
 * leave another server's live process killable by accident.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { logger } from '../../../studio/public/logging'
import { getWebUiHome } from '../../../studio/public/config'

export interface LiveRunRecord {
  sessionId: string
  runId: string
  pid: number
  agentId: string
  profile?: string
  /** Server process that spawned this child. Guards against cross-owner kills. */
  ownerPid: number
  startedAt: number
}

const REGISTRY_FILE = 'live-runs.json'
/** Entries older than this are treated as leftovers and swept on load. */
const STALE_MS = 24 * 60 * 60 * 1000

function registryPath(): string {
  return join(getWebUiHome(), 'coding-agent', REGISTRY_FILE)
}

function readAll(): Record<string, LiveRunRecord> {
  try {
    const raw = readFileSync(registryPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, LiveRunRecord>
  } catch {
    return {}
  }
}

function writeAll(records: Record<string, LiveRunRecord>) {
  const path = registryPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(records, null, 2))
  } catch (err) {
    // Force-stop degrades to the in-memory path, so this must never throw.
    logger.warn(err, '[coding-agent-registry] failed to persist live run registry')
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means it exists but belongs to another user.
    return err?.code === 'EPERM'
  }
}

/**
 * Record a spawned child. Same-session respawns replace the old entry, which is
 * what makes a restart-then-resume cycle converge on one killable pid.
 */
export function registerLiveRun(record: Omit<LiveRunRecord, 'ownerPid' | 'startedAt'>): void {
  if (!record.sessionId || !Number.isInteger(record.pid) || record.pid <= 0) return
  const records = readAll()
  const previous = records[record.sessionId]
  if (previous && previous.pid === record.pid && previous.runId === record.runId) return
  records[record.sessionId] = {
    ...record,
    ownerPid: process.pid,
    startedAt: Date.now(),
  }
  writeAll(records)
}

/** Drop a session's entry once its run is gone. Missing entries are fine. */
export function unregisterLiveRun(sessionId: string, runId?: string): void {
  const records = readAll()
  const current = records[sessionId]
  if (!current) return
  if (runId && current.runId !== runId) return
  delete records[sessionId]
  writeAll(records)
}

/**
 * Find the recorded child for a session, dropping the entry if the process is
 * gone or the record is stale. Returns null rather than a dead pid so the caller
 * never reports a force-stop it did not perform.
 */
export function findLiveRun(sessionId: string): LiveRunRecord | null {
  const records = readAll()
  const record = records[sessionId]
  if (!record) return null
  const stale = Date.now() - record.startedAt > STALE_MS
  if (stale || !pidAlive(record.pid)) {
    delete records[sessionId]
    writeAll(records)
    return null
  }
  return record
}

export function listLiveRuns(): LiveRunRecord[] {
  return Object.values(readAll()).filter(record => !pidAlive(record.pid))
}

/**
 * SIGKILL the recorded child. Falls back to removing a stale registry file so a
 * dead pid cannot be reported as a successful stop.
 */
export function forceKillLiveRun(sessionId: string): { killed: boolean; pid?: number; runId?: string } {
  const records = readAll()
  const record = records[sessionId]
  if (!record) return { killed: false }
  if (!pidAlive(record.pid)) {
    delete records[sessionId]
    writeAll(records)
    return { killed: false, pid: record.pid, runId: record.runId }
  }
  const pid = record.pid
  const runId = record.runId
  try {
    // Kill the whole group first: agents spawn MCP children that would outlive
    // the parent and keep the session "busy" from the user's point of view.
    try { process.kill(-pid, 'SIGKILL') } catch {}
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    logger.warn(err, '[coding-agent-registry] force kill failed for session %s pid %s', sessionId, pid)
    delete records[sessionId]
    writeAll(records)
    return { killed: false, pid, runId }
  }
  delete records[sessionId]
  writeAll(records)
  logger.info({ sessionId, pid, runId }, '[coding-agent-registry] force killed orphan agent process')
  return { killed: true, pid, runId }
}

/** Test seam: drop the whole registry. */
export function clearLiveRunRegistry(): void {
  try {
    const path = registryPath()
    if (existsSync(path)) unlinkSync(path)
  } catch {}
}