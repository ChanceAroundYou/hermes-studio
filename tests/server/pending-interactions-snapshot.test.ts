import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInteractionSnapshot } from '../../packages/server/src/modules/studio/contracts/pending-interaction'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

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
  deadline: Date.now() + 5_000,
  created_at: 100,
  resolved_at: null,
  resolved_reason: null,
  ...over,
})

const PUBLIC_USERS = '../../packages/server/src/modules/studio/public/users'
const DB_INDEX = '../../packages/server/src/modules/studio/infrastructure/database/index'
const SCHEMAS = '../../packages/server/src/modules/studio/infrastructure/database/schemas'
const STORE = '../../packages/server/src/modules/studio/repositories/pending-interaction-store'
const CONTROLLER = '../../packages/server/src/modules/studio/controllers/chat-run'

const RUNTIME = '../../packages/server/src/modules/studio/services/group-chat/runtime'

/** `room-1` belongs to user 7 through the `research` profile; `room-2` does not. */
function stubRoomStorage() {
  const rooms: Record<string, { id: string; ownerAuthUserId: number }> = {
    'room-1': { id: 'room-1', ownerAuthUserId: 7 },
    'room-2': { id: 'room-2', ownerAuthUserId: 99 },
    // `room-3` reaches user 7 only through the member table: an invited member
    // who is not the owner and not covered by the profile room list.
    'room-3': { id: 'room-3', ownerAuthUserId: 99 },
  }
  return {
    getRoom: (roomId: string) => rooms[roomId] ?? null,
    getRoomsForProfiles: (profiles: string[]) =>
      profiles.includes('research') ? [rooms['room-1']] : [],
    getMemberByAuthUserId: (roomId: string, userId: number) =>
      (roomId === 'room-1' || roomId === 'room-3') && userId === 7 ? { id: 'member-1' } : null,
  }
}

function withGroupChat(storage: ReturnType<typeof stubRoomStorage> | null) {
  vi.doMock(RUNTIME, () => ({
    setGroupChatRuntimeServer: vi.fn(),
    getGroupChatRuntimeServer: () => (storage ? { getStorage: () => storage } : null),
  }))
}

const memberUser = { id: 7, role: 'user', profiles: ['research'] }

describe('pending interactions snapshot endpoint', () => {
  let db: import('node:sqlite').DatabaseSync
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock(DB_INDEX, () => ({ getDb: () => db, isSqliteAvailable: () => true }))
    // User 7 may see `research`; anyone else may see nothing.
    vi.doMock(PUBLIC_USERS, () => ({
      listUserProfiles: (userId: number) => (userId === 7 ? [{ profile_name: 'research' }] : []),
    }))
    withGroupChat(stubRoomStorage())
    const { initAllHermesTables } = await import(SCHEMAS)
    initAllHermesTables()
  })
  afterEach(() => {
    db.close()
    vi.doUnmock(DB_INDEX)
    vi.doUnmock(PUBLIC_USERS)
    vi.resetModules()
  })

  const ctxFor = (user: { id: number; role: string } = { id: 7, role: 'user' }, query: Record<string, string> = {}) => (
    { state: { user }, query, status: 200, body: undefined as any }
  )

  it('answers with an empty list, not a 404, when nothing is waiting', async () => {
    const { pendingInteractions } = await import(CONTROLLER)
    const ctx = ctxFor()
    await pendingInteractions(ctx as any)
    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ interactions: [] })
  })

  it('never shows a profile the caller cannot access', async () => {
    const { savePendingInteraction } = await import(STORE)
    const { pendingInteractions } = await import(CONTROLLER)
    savePendingInteraction(item({ profile: 'research' }))
    savePendingInteraction(item({ interaction_id: 'i2', profile: 'other', created_at: 200 }))

    const allowed = ctxFor({ id: 7, role: 'user', profiles: ['research'] } as any)
    await pendingInteractions(allowed as any)
    expect(allowed.body.interactions.map((row: PendingInteractionSnapshot) => row.profile)).toEqual(['research'])

    const admin = ctxFor({ id: 1, role: 'super_admin' })
    await pendingInteractions(admin as any)
    expect(admin.body.interactions.map((row: PendingInteractionSnapshot) => row.profile)).toEqual(['research', 'other'])

    const stranger = ctxFor({ id: 9, role: 'user', profiles: ['research'] } as any)
    await pendingInteractions(stranger as any)
    expect(stranger.body.interactions).toEqual([])
  })

  it('carries every carrier and every field the card needs', async () => {
    const { savePendingInteraction } = await import(STORE)
    const { pendingInteractions } = await import(CONTROLLER)
    savePendingInteraction(item({ scope: 'session', owner_id: 'session-1' }))
    savePendingInteraction(item({ scope: 'room', owner_id: 'room-1', kind: 'approval', choices: null, created_at: 200 }))
    savePendingInteraction(item({ scope: 'device', owner_id: 'device-1', created_at: 300 }))
    const ctx = ctxFor()
    await pendingInteractions(ctx as any)
    const seenAt = Date.now()
    expect(ctx.body.interactions.map((row: any) => [row.scope, row.owner_id, row.kind, row.question, row.choices])).toEqual([
      ['session', 'session-1', 'clarify', 'Which folder?', ['client', 'server']],
      ['room', 'room-1', 'approval', 'Which folder?', null],
      ['device', 'device-1', 'clarify', 'Which folder?', ['client', 'server']],
    ])
    // The row carries the remaining duration, never the stored instant.
    for (const row of ctx.body.interactions) {
      expect(row.deadline).toBeUndefined()
      expect(row.remaining_timeout_ms).toBeGreaterThanOrEqual(0)
      // A duration near the 5s window, never a wall-clock instant (~1.7e12).
      expect(row.remaining_timeout_ms).toBeGreaterThan(4_000)
      expect(Date.now() - seenAt + row.remaining_timeout_ms).toBeLessThan(6_000)
    }
  })

  it('leaves out interactions that already ended', async () => {
    const { savePendingInteraction, resolvePendingInteraction } = await import(STORE)
    const { pendingInteractions } = await import(CONTROLLER)
    savePendingInteraction(item())
    savePendingInteraction(item({ interaction_id: 'i2', created_at: 200, deadline: null }))
    resolvePendingInteraction('session', 'session-1', 'i1', 'response')
    const ctx = ctxFor()
    await pendingInteractions(ctx as any)
    expect(ctx.body.interactions.map((row: PendingInteractionSnapshot) => row.interaction_id)).toEqual(['i2'])
    // No deadline stays absent rather than collapsing into "expires now".
    expect((ctx.body.interactions[0] as any).remaining_timeout_ms).toBeNull()
  })

  it('answers from storage, so a live in-memory prompt the store never saw is not invented', async () => {
    const { ClarificationRuns } = await import('../../packages/server/src/modules/studio/services/clarification-runs')
    const { pendingInteractions } = await import(CONTROLLER)
    const runs = new ClarificationRuns(vi.fn())
    runs.begin('ctx-1', 'session-1', 'research', () => ({ isWorking: true, activeRunMarker: 'turn-1' }))
    const waiting = runs.request('ctx-1', 'research', { question: 'Only in memory' })
    const ctx = ctxFor()
    await pendingInteractions(ctx as any)
    expect(ctx.body.interactions).toEqual([])
    runs.finishSession('session-1')
    await waiting
  })

  describe('room prompts only reach people who are in that room', () => {
    it('keeps an invited member room prompt visible without making them a manager', async () => {
      const { savePendingInteraction } = await import(STORE)
      const { pendingInteractions } = await import(CONTROLLER)
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-3' }))
      const ctx = ctxFor(memberUser as any)
      await pendingInteractions(ctx as any)
      expect(ctx.body.interactions.map((row: PendingInteractionSnapshot) => row.owner_id)).toEqual(['room-3'])
    })

    it('hides another room prompt from a non-member who shares the profile', async () => {
      const { savePendingInteraction } = await import(STORE)
      withGroupChat(stubRoomStorage())
      const { pendingInteractions } = await import(CONTROLLER)
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-1' }))
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-2', interaction_id: 'i2', created_at: 200 }))

      const ctx = ctxFor(memberUser as any)
      await pendingInteractions(ctx as any)
      expect(ctx.body.interactions.map((row: PendingInteractionSnapshot) => row.owner_id)).toEqual(['room-1'])
    })

    it('keeps session and device carriers unaffected by the room gate', async () => {
      const { savePendingInteraction } = await import(STORE)
      withGroupChat(stubRoomStorage())
      const { pendingInteractions } = await import(CONTROLLER)
      savePendingInteraction(item({ scope: 'session', owner_id: 'session-1' }))
      savePendingInteraction(item({ scope: 'device', owner_id: 'device-1', created_at: 200 }))
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-2', interaction_id: 'i3', created_at: 300 }))

      const ctx = ctxFor(memberUser as any)
      await pendingInteractions(ctx as any)
      expect(ctx.body.interactions.map((row: PendingInteractionSnapshot) => row.scope)).toEqual(['session', 'device'])
    })

    it('leaves room prompts out when the group chat service is unavailable', async () => {
      const { savePendingInteraction } = await import(STORE)
      withGroupChat(null)
      const { pendingInteractions } = await import(CONTROLLER)
      savePendingInteraction(item({ scope: 'session', owner_id: 'session-1' }))
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-1', interaction_id: 'i2', created_at: 200 }))

      const ctx = ctxFor(memberUser as any)
      await pendingInteractions(ctx as any)
      expect(ctx.body.interactions.map((row: PendingInteractionSnapshot) => row.scope)).toEqual(['session'])
    })

    it('a super admin still sees every room', async () => {
      const { savePendingInteraction } = await import(STORE)
      withGroupChat(stubRoomStorage())
      const { pendingInteractions } = await import(CONTROLLER)
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-1' }))
      savePendingInteraction(item({ scope: 'room', owner_id: 'room-2', interaction_id: 'i2', created_at: 200 }))

      const ctx = ctxFor({ id: 1, role: 'super_admin' })
      await pendingInteractions(ctx as any)
      expect(ctx.body.interactions.map((row: PendingInteractionSnapshot) => row.owner_id)).toEqual(['room-1', 'room-2'])
    })
  })

  it('filters by carrier on request and rejects an unknown one', async () => {
    const { savePendingInteraction } = await import(STORE)
    const { pendingInteractions } = await import(CONTROLLER)
    savePendingInteraction(item({ scope: 'session', owner_id: 'session-1' }))
    savePendingInteraction(item({ scope: 'room', owner_id: 'room-1', created_at: 200 }))
    const filtered = ctxFor({ id: 1, role: 'super_admin' }, { scope: 'room' })
    await pendingInteractions(filtered as any)
    expect(filtered.body.interactions.map((row: PendingInteractionSnapshot) => row.scope)).toEqual(['room'])

    const bogus = ctxFor({ id: 1, role: 'super_admin' }, { scope: 'everything' })
    await pendingInteractions(bogus as any)
    expect(bogus.status).toBe(400)
    expect(bogus.body).toMatchObject({ ok: false })
  })
})
