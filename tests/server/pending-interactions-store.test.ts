import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInteractionSnapshot } from '../../packages/server/src/modules/studio/contracts/pending-interaction'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** A pending interaction must survive a restart with every field the card renders. */
const item = (over: Partial<PendingInteractionSnapshot> = {}): PendingInteractionSnapshot => ({
  scope: 'session',
  owner_id: 'session-1',
  interaction_id: 'i1',
  kind: 'clarify',
  status: 'pending',
  profile: 'research',
  question: 'Which folder?',
  choices: ['client', 'server'],
  run_id: 'turn-1',
  context_id: 'context-1',
  deadline: 1_700_000_000_000,
  created_at: 100,
  resolved_at: null,
  resolved_reason: null,
  ...over,
})

describe('pending interaction persistence', () => {
  let db: import('node:sqlite').DatabaseSync
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('round-trips every field the card renders', async () => {
    const { savePendingInteraction, listPendingInteractions } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item())
    expect(listPendingInteractions()).toEqual([item()])
    // A choice list may legitimately be absent; null must not become [].
    savePendingInteraction(item({ interaction_id: 'i2', choices: null, created_at: 200 }))
    expect(listPendingInteractions({ scope: 'session', ownerIds: ['session-1'] }).map(row => row.choices))
      .toEqual([['client', 'server'], null])
  })

  it('re-publishing the same interaction updates one row instead of duplicating it', async () => {
    const { savePendingInteraction, listPendingInteractions } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item())
    savePendingInteraction(item({ question: 'Which folder really?', deadline: 1_700_000_060_000 }))
    expect(listPendingInteractions()).toEqual([item({ question: 'Which folder really?', deadline: 1_700_000_060_000 })])
  })

  it('hides terminated interactions unless they are explicitly requested', async () => {
    const { savePendingInteraction, listPendingInteractions, resolvePendingInteraction } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item())
    savePendingInteraction(item({ interaction_id: 'i2', created_at: 200 }))
    expect(resolvePendingInteraction('session', 'session-1', 'i1', 'response')).toBe(true)
    expect(listPendingInteractions().map(row => row.interaction_id)).toEqual(['i2'])
    expect(listPendingInteractions({ includeResolved: true }).map(row => row.interaction_id)).toEqual(['i1', 'i2'])
    expect(listPendingInteractions({ includeResolved: true }).find(row => row.interaction_id === 'i1'))
      .toMatchObject({ status: 'resolved', resolved_reason: 'response' })
    expect(listPendingInteractions({ includeResolved: true }).find(row => row.interaction_id === 'i1')!.resolved_at).toBeGreaterThan(0)
    // Resolving twice is not an error, but it must not look like it did anything.
    expect(resolvePendingInteraction('session', 'session-1', 'i1', 'dismissed')).toBe(false)
    expect(resolvePendingInteraction('session', 'session-1', 'missing', 'dismissed')).toBe(false)
  })

  it('maps a terminal reason onto the matching status', async () => {
    const { savePendingInteraction, listPendingInteractions, resolvePendingInteraction } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item({ interaction_id: 'i1' }))
    savePendingInteraction(item({ interaction_id: 'i2', created_at: 200 }))
    savePendingInteraction(item({ interaction_id: 'i3', created_at: 300 }))
    resolvePendingInteraction('session', 'session-1', 'i1', 'timeout')
    resolvePendingInteraction('session', 'session-1', 'i2', 'aborted')
    resolvePendingInteraction('session', 'session-1', 'i3', 'dismissed')
    expect(listPendingInteractions({ includeResolved: true }).map(row => [row.interaction_id, row.status]))
      .toEqual([['i1', 'expired'], ['i2', 'aborted'], ['i3', 'resolved']])
    expect(listPendingInteractions()).toEqual([])
  })

  it('keeps the same interaction id apart across the three scopes', async () => {
    const { savePendingInteraction, listPendingInteractions } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item({ scope: 'session', owner_id: 'owner-a' }))
    savePendingInteraction(item({ scope: 'room', owner_id: 'owner-a' }))
    savePendingInteraction(item({ scope: 'device', owner_id: 'owner-a' }))
    expect(listPendingInteractions()).toHaveLength(3)
    expect(listPendingInteractions({ scope: 'room' }).map(row => row.scope)).toEqual(['room'])
    expect(new Set(listPendingInteractions().map(row => row.interaction_id))).toEqual(new Set(['i1']))
  })

  it('keeps the same interaction id apart across owners inside one scope', async () => {
    const { savePendingInteraction, listPendingInteractions } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item({ owner_id: 'owner-a' }))
    savePendingInteraction(item({ owner_id: 'owner-b', created_at: 200 }))
    expect(listPendingInteractions({ ownerIds: ['owner-a'] }).map(row => row.owner_id)).toEqual(['owner-a'])
    expect(listPendingInteractions({ ownerIds: ['owner-a', 'owner-b'] })).toHaveLength(2)
    expect(listPendingInteractions({ ownerIds: ['owner-c'] })).toEqual([])
    // An empty allow-list means "none are visible", never "no filter".
    expect(listPendingInteractions({ ownerIds: [] })).toEqual([])
  })

  it('filters by the profiles the caller may see', async () => {
    const { savePendingInteraction, listPendingInteractions } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item({ profile: 'research' }))
    savePendingInteraction(item({ interaction_id: 'i2', profile: 'other', created_at: 200 }))
    expect(listPendingInteractions({ profiles: ['research'] }).map(row => row.profile)).toEqual(['research'])
    // An empty allow-list means "nothing is visible", never "no filter".
    expect(listPendingInteractions({ profiles: [] })).toEqual([])
  })

  it('is safe to migrate twice', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    expect(() => initAllHermesTables()).not.toThrow()
    const { savePendingInteraction, listPendingInteractions } = await import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')
    savePendingInteraction(item())
    expect(listPendingInteractions()).toHaveLength(1)
  })
})
