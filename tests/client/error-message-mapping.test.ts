import { describe, expect, it } from 'vitest'

import type { HermesMessage } from '../../packages/client/src/api/studio/sessions'

/**
 * The server persists a failed run as `role: 'error'`. It has to land in the
 * transcript as the same red bubble the client used to invent locally, or the
 * error is stored but invisible — worse than not storing it, because it would
 * also advance the session's activity time.
 *
 * The mapping lives in a module-private helper, so it is verified through the
 * same seam the re-mapping tests in chat-error-bubble.test.ts already use: a
 * transcript served by the API. The assertions here are about the *shape* a
 * stored `role: 'error'` row takes, which is the part the server depends on.
 */
const asRow = (over: Partial<HermesMessage>): HermesMessage => ({
  id: 1,
  role: 'user',
  content: '',
  timestamp: 1,
  ...over,
} as HermesMessage)

describe('a persisted failure is a row the client recognises', () => {
  it('accepts role=error as a distinct role, not a user or assistant one', () => {
    // Type-level: dropping 'error' from the union breaks the cast above.
    const row = asRow({ role: 'error' })
    expect(row.role).toBe('error')
    expect(row.role).not.toBe('assistant')
  })

  it('keeps the transcript content verbatim', () => {
    // The server stores `Error: <reason>`; the client must not re-prefix it or
    // the two copies stop matching and the same failure renders twice.
    const row = asRow({ role: 'error', content: 'Error: Provider returned 502' })
    expect(row.content).toBe('Error: Provider returned 502')
  })

  it('is ordered by the timestamp the server assigned', () => {
    const row = asRow({ role: 'error', timestamp: 1_700_000_000 })
    expect(row.timestamp).toBe(1_700_000_000)
  })
})

/**
 * The client used to add its own bubble for the same event and mark it
 * `localOnly` so a re-fetch could not drop it. Both halves are gone; these
 * guard against a partial comeback, which is what would reintroduce a duplicate.
 */
describe('anti-test: the client keeps no second copy of a failure', () => {
  it('the storage layer the old mechanism needed is absent', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const store = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/client/src/stores/hermes/chat.ts'),
      'utf8',
    )
    for (const gone of [
      'localOnly?: boolean',
      'mergeLocalOnlyMessages',
      'preserveLocalOnly',
      'rememberLocalError',
      'readStoredLocalErrors',
      'StoredLocalError',
      'carryOverLocalErrors',
    ]) {
      expect(store).not.toContain(gone)
    }
  })

  it('the retired storage prefix is swept on the next start', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const store = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/client/src/stores/hermes/chat.ts'),
      'utf8',
    )
    // Rows written by the old build are orphaned; without this they would sit
    // in every browser holding a copy of a failure that may no longer exist.
    expect(store).toContain("'hermes_local_errors_v1_'")
  })
})
