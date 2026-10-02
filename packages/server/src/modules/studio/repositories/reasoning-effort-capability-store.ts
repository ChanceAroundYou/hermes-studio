import { getDb } from '../infrastructure/database'

/**
 * Durable record of which reasoning_effort levels a deployment actually takes.
 *
 * Without this the process relearns everything after a restart and a provider
 * that rejected `max` yesterday rejects it again today. Rows are a cache of
 * observed behaviour, never a source of permission: a row can only narrow what
 * the static table already allows.
 */

export interface EffortCapabilityRow {
  provider: string
  model: string
  supported: string[]
  rejected: string[]
  updated_at: number
}

const initialized = new WeakSet<object>()

/**
 * Returns null whenever the table is not usable. This is a cache: a missing,
 * closed or unwritable database must degrade to "learn again", never throw into
 * the request path.
 */
function database(): any {
  try {
    const db = getDb()
    if (!db) return null
    if (!initialized.has(db)) {
      db.exec(`CREATE TABLE IF NOT EXISTS reasoning_effort_capabilities (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        supported TEXT NOT NULL DEFAULT '',
        rejected TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      )`)
      initialized.add(db)
    }
    return db
  } catch {
    return null
  }
}

function split(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  return value.split(',').map(part => part.trim()).filter(Boolean)
}

/** Load everything learned so far into memory. Safe to call once at boot. */
export function loadEffortCapabilities(): number {
  const db = database()
  if (!db) return 0
  try {
    const rows = db
      .prepare('SELECT provider, model, supported, rejected FROM reasoning_effort_capabilities')
      .all() as Array<{ provider: string; model: string; supported: string; rejected: string }>
    for (const row of rows) {
      hydrate(row.provider, row.model, split(row.supported), split(row.rejected))
    }
    return rows.length
  } catch {
    // A read failure must not stop the server booting; the in-memory layer still
    // works and will repopulate as requests come in.
    return 0
  }
}

let hydrate: (provider: string, model: string, supported: string[], rejected: string[]) => void = () => {}
let persist: (provider: string, model: string, supported: string[], rejected: string[]) => void = () => {}

/** Wired by reasoning-effort-resolve so this store does not import it. */
export function registerEffortCapabilityHooks(hooks: {
  hydrate: typeof hydrate
  persist: typeof persist
}): void {
  hydrate = hooks.hydrate
  persist = hooks.persist
}

/** Write one deployment's answer. Debounced by the caller. */
export function saveEffortCapability(provider: string, model: string, supported: string[], rejected: string[]): void {
  const db = database()
  if (!db) return
  try {
    db.prepare(
      `INSERT INTO reasoning_effort_capabilities (provider, model, supported, rejected, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         supported = excluded.supported,
         rejected = excluded.rejected,
         updated_at = excluded.updated_at`,
    ).run(provider, model, supported.join(','), rejected.join(','), Date.now())
  } catch {
    // Persistence is a cache; failing to write must never fail the request.
  }
}

/** Forget one deployment, used when a probe should start from the table again. */
export function clearEffortCapability(provider: string, model: string): void {
  const db = database()
  if (!db) return
  try {
    db.prepare('DELETE FROM reasoning_effort_capabilities WHERE provider=? AND model=?').run(provider, model)
  } catch {
    // ignored on purpose
  }
}
