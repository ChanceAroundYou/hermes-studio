// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = 'test' })
import { createPinia, setActivePinia } from 'pinia'

const groupChatApiMock = vi.hoisted(() => {
  const socket: any = {
    connected: true,
    id: 'socket-1',
    on: vi.fn(() => socket),
    once: vi.fn(() => socket),
    off: vi.fn(() => socket),
    emit: vi.fn(() => socket),
    disconnect: vi.fn(),
  }
  return {
    socket,
    connectGroupChat: vi.fn(() => socket),
    disconnectGroupChat: vi.fn(),
    getSocket: vi.fn(() => socket),
    getStoredUserId: vi.fn(() => 'user-1'),
    getStoredUserName: vi.fn(() => 'tester'),
    createRoom: vi.fn(), listRooms: vi.fn(), getRoomDetail: vi.fn(), joinRoomByCode: vi.fn(),
    addAgent: vi.fn(), updateAgent: vi.fn(), listAgents: vi.fn(), removeAgent: vi.fn(),
    cloneRoom: vi.fn(), deleteRoom: vi.fn(), clearRoomContext: vi.fn(), updateInviteCode: vi.fn(),
  }
})
vi.mock('@/api/studio/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => 'test-token'),
  getBaseUrlValue: vi.fn(() => ''),
  getActiveProfileName: vi.fn(() => 'research'),
  getStoredUsername: vi.fn(() => null),
  wsOrigin: vi.fn(() => ({ host: '', prefix: '' })),
}))
vi.mock('@/api/studio/auth', () => ({ fetchCurrentUser: vi.fn() }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: vi.fn((path: string) => path) }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn() }))
vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({ display: { bell_on_complete: false, approval_bell: true } }),
}))
const pendingMock = vi.hoisted(() => ({ fetchPendingInteractions: vi.fn(async () => []) }))
vi.mock('@/api/studio/sessions', () => pendingMock)
vi.stubGlobal('fetch', vi.fn())

import { useGroupChatStore } from '@/stores/hermes/group-chat'

/** A stored row as the snapshot endpoint returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  scope: 'room',
  owner_id: 'room-1',
  interaction_id: 'c1',
  kind: 'clarify',
  status: 'pending',
  profile: 'research',
  question: 'Which folder?',
  choices: ['client', 'server'],
  run_id: 'turn-1',
  context_id: null,
  remaining_timeout_ms: 120_000,
  created_at: 1,
  resolved_at: null,
  resolved_reason: null,
  ...over,
} as never)

beforeEach(() => {
  vi.resetAllMocks()
  groupChatApiMock.socket.connected = true
  pendingMock.fetchPendingInteractions.mockImplementation(async () => [])
  setActivePinia(createPinia())
})

describe('room prompts survive a reload', () => {
  it('fills a prompt the server still holds, under the room that owns it', async () => {
    const store = useGroupChatStore()

    store.applyPendingInteractionsSnapshot([row()])

    expect([...store.pendingClarifies.keys()]).toEqual(['room-1:c1'])
    expect(store.pendingClarifies.get('room-1:c1')).toMatchObject({
      roomId: 'room-1', clarifyId: 'c1', question: 'Which folder?', choices: ['client', 'server'],
    })
  })

  it('drops a prompt the server no longer holds', async () => {
    const store = useGroupChatStore()
    store.applyPendingInteractionsSnapshot([row(), row({ interaction_id: 'c2' })])
    expect([...store.pendingClarifies.keys()].sort()).toEqual(['room-1:c1', 'room-1:c2'])

    // c2 was answered while this tab was closed.
    store.applyPendingInteractionsSnapshot([row()])
    expect([...store.pendingClarifies.keys()]).toEqual(['room-1:c1'])
  })

  it('leaves a prompt already on screen alone, so its countdown keeps running', () => {
    const store = useGroupChatStore()
    store.applyPendingInteractionsSnapshot([row()])
    const before = store.pendingClarifies.get('room-1:c1')

    store.applyPendingInteractionsSnapshot([row()])

    expect(store.pendingClarifies.get('room-1:c1')).toBe(before)
  })

  it('leaves carriers this store does not own to their own store', () => {
    const store = useGroupChatStore()

    // A single-chat prompt belongs to the chat store; half-rendering it here
    // would give the same question two owners.
    store.applyPendingInteractionsSnapshot([row({ scope: 'session', owner_id: 'session-9' })])
    expect([...store.pendingClarifies.keys()]).toEqual([])

    // An approval is not a clarification: it has its own surface and its own answer.
    store.applyPendingInteractionsSnapshot([row({ kind: 'approval' })])
    expect([...store.pendingClarifies.keys()]).toEqual([])
  })

  it('keeps the local cards when the read fails', async () => {
    const store = useGroupChatStore()
    store.applyPendingInteractionsSnapshot([row()])
    pendingMock.fetchPendingInteractions.mockImplementation(async () => { throw new Error('offline') })

    await store.reconcilePendingInteractionsQuietly()

    expect([...store.pendingClarifies.keys()]).toEqual(['room-1:c1'])
  })

  it('reads the server when it reconciles', async () => {
    const store = useGroupChatStore()
    pendingMock.fetchPendingInteractions.mockImplementation(async () => [row()])

    await store.reconcilePendingInteractionsQuietly()

    expect([...store.pendingClarifies.keys()]).toEqual(['room-1:c1'])
  })
})

describe('the room prompts the server says are open', () => {
  it('replaces the set, so a prompt answered elsewhere disappears', () => {
    const store = useGroupChatStore()
    store.applyRoomClarifySnapshot([
      { roomId: 'room-1', clarify_id: 'c1', question: 'Q1', choices: ['a'] },
      { roomId: 'room-2', clarify_id: 'c2', question: 'Q2', choices: null },
    ])
    expect([...store.pendingClarifies.keys()].sort()).toEqual(['room-1:c1', 'room-2:c2'])

    store.applyRoomClarifySnapshot([{ roomId: 'room-2', clarify_id: 'c2', question: 'Q2', choices: null }])
    expect([...store.pendingClarifies.keys()]).toEqual(['room-2:c2'])
  })

  it('covers every room the user manages, not only the open one', () => {
    const store = useGroupChatStore()

    // This is what lets a prompt raised in a room reach someone who is looking
    // at a single chat: the server already answered "which rooms can this user
    // manage", and it answered with all of them.
    store.applyRoomClarifySnapshot([{ roomId: 'room-unopened', clarify_id: 'c9', question: 'Q9' }])

    expect([...store.pendingClarifies.keys()]).toEqual(['room-unopened:c9'])
  })

  it('leaves the local cards alone when the answer is not a list', () => {
    const store = useGroupChatStore()
    store.applyRoomClarifySnapshot([{ roomId: 'room-1', clarify_id: 'c1', question: 'Q1' }])

    // A malformed or absent snapshot must not be read as "nothing is open".
    store.applyRoomClarifySnapshot(undefined)
    store.applyRoomClarifySnapshot('nope')

    expect([...store.pendingClarifies.keys()]).toEqual(['room-1:c1'])
  })
})
