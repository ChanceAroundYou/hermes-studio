import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * A group chat keeps its own in-memory route map, because the answer has to
 * travel back to the agent that is waiting. That map dies with the process, so a
 * user who reloads mid-prompt used to see nothing at all, and a room prompt was
 * invisible to anyone who was not sitting in the room.
 *
 * These are the store-side helpers the socket calls to mirror the same prompts
 * into `pending_interactions` under `scope = 'room'`.
 */
describe('room prompts in the pending-interaction store', () => {
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

  const load = () => import('../../packages/server/src/modules/studio/services/group-chat/pending-interactions')
  const store = () => import('../../packages/server/src/modules/studio/repositories/pending-interaction-store')

  const input = (over: Record<string, unknown> = {}) => ({
    roomId: 'room-1',
    profile: 'research',
    clarifyId: 'c1',
    question: 'Which folder?',
    choices: ['client', 'server'] as string[] | null,
    runId: 'turn-1',
    timeoutMs: 300_000,
    requestedAt: 1_700_000_000_000,
    ...over,
  } as never)

  it('stores a room prompt under scope=room, owned by the room', async () => {
    const { persistRoomClarify } = await load()
    const { listPendingInteractions } = await store()

    persistRoomClarify(input())

    const rows = listPendingInteractions({ scope: 'room' })
    expect(rows).toMatchObject([{
      scope: 'room',
      owner_id: 'room-1',
      interaction_id: 'c1',
      kind: 'clarify',
      status: 'pending',
      profile: 'research',
      question: 'Which folder?',
      choices: ['client', 'server'],
      run_id: 'turn-1',
      // The wire carries the remaining duration, so the stored deadline is the
      // absolute instant the request was made plus the window it was given.
      deadline: 1_700_000_300_000,
      created_at: 1_700_000_000_000,
      resolved_at: null,
      resolved_reason: null,
    }])
    // The group client matches prompts by room, so the row must name the room --
    // a `session_id` field would send it looking for a session that never existed.
    expect(Object.keys(rows[0])).not.toContain('session_id')
    expect(rows[0].owner_id).toBe('room-1')
  })

  it('does not let a room and a session collide on the same interaction id', async () => {
    const { persistRoomClarify } = await load()
    const { savePendingInteraction, listPendingInteractions } = await store()

    persistRoomClarify(input({ roomId: 'shared', question: 'Room?' }))
    savePendingInteraction({
      scope: 'session', owner_id: 'shared', interaction_id: 'c1', kind: 'clarify', status: 'pending',
      profile: 'research', question: 'Session?', choices: null, run_id: null, context_id: null,
      deadline: 200, created_at: 100, resolved_at: null, resolved_reason: null,
    })

    expect(listPendingInteractions({ scope: 'room', ownerIds: ['shared'] }).map(row => row.question)).toEqual(['Room?'])
    expect(listPendingInteractions({ scope: 'session', ownerIds: ['shared'] }).map(row => row.question)).toEqual(['Session?'])
  })

  it('settles one room prompt without touching its neighbours', async () => {
    const { persistRoomClarify, settleRoomClarify, listRoomClarifies } = await load()
    const { listPendingInteractions } = await store()

    persistRoomClarify(input({ clarifyId: 'c1' }))
    persistRoomClarify(input({ clarifyId: 'c2' }))
    persistRoomClarify(input({ roomId: 'room-2', clarifyId: 'c1' }))

    expect(settleRoomClarify('room-1', 'c1', 'response')).toBe(true)
    // Answering twice is not a second answer.
    expect(settleRoomClarify('room-1', 'c1', 'response')).toBe(false)

    expect(listRoomClarifies('room-1').map(row => row.interaction_id)).toEqual(['c2'])
    expect(listPendingInteractions({ scope: 'room', includeResolved: true })
      .find(row => row.owner_id === 'room-1' && row.interaction_id === 'c1'))
      .toMatchObject({ status: 'resolved', resolved_reason: 'response' })
    // Room 2's identically numbered prompt is untouched.
    expect(listRoomClarifies('room-2').map(row => row.interaction_id)).toEqual(['c1'])
  })

  it('settles every prompt of one room at once, and only that room', async () => {
    const { persistRoomClarify, settleRoomClarifies, listRoomClarifies } = await load()

    persistRoomClarify(input({ clarifyId: 'c1' }))
    persistRoomClarify(input({ clarifyId: 'c2' }))
    persistRoomClarify(input({ roomId: 'room-2', clarifyId: 'c3' }))

    expect(settleRoomClarifies('room-1', 'aborted')).toBe(2)
    expect(listRoomClarifies('room-1')).toEqual([])
    expect(listRoomClarifies('room-2').map(row => row.interaction_id)).toEqual(['c3'])
  })

  it('never hands back an abandoned prompt as answerable', async () => {
    const { persistRoomClarify, settleRoomClarify, listRoomClarifies } = await load()

    persistRoomClarify(input({ clarifyId: 'gone' }))
    settleRoomClarify('room-1', 'gone', 'expired')

    // `listRoomClarifies` is what a client reconciles against, so a terminal row
    // must simply not be in it.
    expect(listRoomClarifies('room-1')).toEqual([])
  })
})

/**
 * `GroupChatServer` opens a socket.io server and a storage handle in its
 * constructor, so its handlers are not unit-testable. These pin the wiring
 * instead: the store only helps if the socket still calls it.
 */
describe('room prompts are wired into the group chat socket', () => {
  const source = () => readFileSync(
    new URL('../../packages/server/src/modules/studio/sockets/group-chat.ts', import.meta.url), 'utf8',
  )
  const span = (text: string, start: string, end: string) => {
    const from = text.indexOf(start)
    expect(from).toBeGreaterThan(-1)
    const to = text.indexOf(end, from)
    expect(to).toBeGreaterThan(from)
    return text.slice(from, to)
  }

  it('records the room prompt when the agent asks', () => {
    const asked = span(source(), 'private handleClarifyRequested(', 'private handleClarifyResolved(')
    expect(asked).toContain('persistRoomClarify({')
    // The row must name the profile the room lives in, or the snapshot's
    // allow-list would filter the room's own prompt back out again.
    expect(asked).toContain("this.storage.getRoom(roomId)?.summaryProfile || 'default'")
  })

  it('settles the stored row from the one path every removal goes through', () => {
    const take = span(source(), 'private takePendingClarifyRoute(', 'private schedulePendingApprovalExpiry(')
    expect(take).toContain('settleRoomClarify(route.roomId, route.clarifyId, reason)')
    expect(take).toContain("reason: PendingInteractionReason = 'cancelled'")
  })

  it('tells answered, expired and interrupted apart', () => {
    const text = source()
    const respond = span(text, 'private async handleClarifyRespond(', 'expirePendingAgentInteractions(')
    expect(respond).toContain("this.takePendingClarifyRoute(routeKey, 'response')")
    expect(text).toContain("this.takePendingClarifyRoute(routeKey, 'expired')")
    expect(text).toContain("this.takePendingClarifyRoute(routeKey, 'aborted')")
    expect(text).toContain("data.resolved === false ? 'dismissed' : 'response'")
  })

  it('clears the whole room in storage, not only in memory', () => {
    const cleared = span(source(), 'private clearPendingClarifyRoutes(', 'private handleDisconnect(')
    expect(cleared).toContain("settleRoomClarifies(roomId, 'cancelled')")
  })
})

describe('a room prompt keeps its own carrier', () => {
  const source = () => readFileSync(
    new URL('../../packages/server/src/modules/studio/sockets/group-chat.ts', import.meta.url), 'utf8',
  )
  const span = (text: string, start: string, end: string) => {
    const from = text.indexOf(start)
    expect(from).toBeGreaterThan(-1)
    const to = text.indexOf(end, from)
    expect(to).toBeGreaterThan(from)
    return text.slice(from, to)
  }

  it('announces it by room, never by session', () => {
    const asked = span(source(), 'private handleClarifyRequested(', 'private handleClarifyResolved(')
    const emitted = asked.slice(asked.indexOf("emitToRoomManagers(roomId, 'clarify.requested'"))
    // The group client indexes prompts by room. Sending a session id here would
    // send it looking for a session that never existed.
    expect(emitted).toContain('roomId,')
    expect(emitted).not.toContain('session_id')
  })

  it('is not also announced as a session prompt', () => {
    // Deliberately pinned. The chat-run socket suppresses the group copy because
    // the room's own gated snapshot already carries it; re-enabling that path
    // would render one prompt twice, and only one of the two would be answerable.
    const chatRun = readFileSync(
      new URL('../../packages/server/src/modules/studio/sockets/chat-run.ts', import.meta.url), 'utf8',
    )
    const emit = span(chatRun, 'private emitPendingInteraction(', 'private emitSessionActivity(')
    expect(emit).toContain("if (source === 'group_chat') return")
  })
})
