// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))
import { nextTick } from 'vue'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  connectChatRun: vi.fn(),
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,

  getBaseUrlValue: vi.fn(() => ''),
  wsOrigin: vi.fn(() => ({ host: '', prefix: '' })),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkingSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: vi.fn(async () => ({ messages: [], hasMore: false })),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}


/**
 * A completed compression used to render only inside the run indicator, which is
 * gated on the run being live. Two consequences, both fixed here:
 *
 *   - it vanished the moment the run settled, even though a compression
 *     permanently discards context and is a fact about the conversation
 *   - it was absent from any re-fetched transcript, because it never entered
 *     the messages array at all
 *
 * It is now a real transcript entry ordered by when it started. Not persisted,
 * so a refresh can still lose it.
 */
describe('compression becomes a transcript entry', () => {
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    vi.resetAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      // isWorking keeps the store on the socket path, which is what registers
      // the per-session handlers the compression events arrive on.
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  /** switchSession only wires handlers when the REST page load is skipped. */
  async function attach() {
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    if (!handlers) {
      const call = chatApi.registerSessionHandlers.mock.calls.find(item => item[0] === 'session-1')
      handlers = call?.[1]
    }
    expect(handlers, 'session handlers were never registered').toBeTruthy()
    return store
  }

  it('writes a compression into the message flow when it completes', async () => {
    const store = await attach()

    handlers.onCompressionStarted({
      event: 'compression.started',
      session_id: 'session-1',
      message_count: 365,
      token_count: 90100,
      started_at: 1_700_000_000_000,
    })
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 365,
      beforeTokens: 90100,
      afterTokens: 16500,
      compressed: true,
      started_at: 1_700_000_000_000,
    })

    const entries = store.activeSession!.messages.filter(m => m.compression)
    expect(entries).toHaveLength(1)
    expect(entries[0].role).toBe('system')
    expect(entries[0].systemType).toBe('compression')
    expect(entries[0].compression).toMatchObject({
      compressed: true,
      messageCount: 365,
      beforeTokens: 90100,
      afterTokens: 16500,
    })
  })

  it('positions the entry by when the compression started, not when it arrived', async () => {
    const store = await attach()
    const session = store.activeSession!
    // Messages sent before the compression, and after it.
    session.messages.push(
      { id: 'before-1', role: 'user', content: 'older', timestamp: 1_699_999_000_000 },
      { id: 'after-1', role: 'user', content: 'newer', timestamp: 1_700_000_500_000 },
    )

    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 365,
      beforeTokens: 90100,
      afterTokens: 16500,
      compressed: true,
      started_at: 1_700_000_000_000,
    })

    const order = session.messages.map(m => m.id)
    expect(order).toEqual(['before-1', expect.stringContaining('compression:'), 'after-1'])
  })

  it('keeps the entry after the run settles', async () => {
    const store = await attach()
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 365,
      beforeTokens: 90100,
      afterTokens: 16500,
      compressed: true,
      started_at: 1_700_000_000_000,
    })
    // The run ends: this is the condition that used to hide the notice.
    handlers.onRunCompleted({ event: 'run.completed', session_id: 'session-1' })

    expect(store.activeSession!.messages.filter(m => m.compression)).toHaveLength(1)
  })

  it('updates one entry when the same compression is delivered twice', async () => {
    const store = await attach()
    const event = {
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 365,
      beforeTokens: 90100,
      compressed: true,
      started_at: 1_700_000_000_000,
    }
    handlers.onCompressionCompleted(event)
    handlers.onCompressionCompleted({ ...event, afterTokens: 16000 })

    const entries = store.activeSession!.messages.filter(m => m.compression)
    expect(entries).toHaveLength(1)
    // The second delivery carries the final numbers, not the first snapshot.
    expect(entries[0].compression?.afterTokens).toBe(16000)
  })

  it('survives the run settling, which is what used to hide it', async () => {
    const store = await attach()
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 365,
      beforeTokens: 90100,
      afterTokens: 16500,
      compressed: true,
      started_at: 1_700_000_000_000,
    })
    // The run ends. The run indicator -- the only place this notice used to
    // live -- is gated on the run being live, so this is the moment it silently
    // disappeared from.
    handlers.onRunCompleted({ event: 'run.completed', session_id: 'session-1' })
    await nextTick()

    expect(store.activeSession!.messages.filter(m => m.compression)).toHaveLength(1)
  })

  it('records a /compact compression the same way as an automatic one', async () => {
    const store = await attach()
    // Both sources converge on one entry. An earlier version skipped
    // command-sourced compressions because /compact persisted its own text
    // message; that produced two differently-shaped lines for one compression.
    // The server now persists a structured record for both, so the client keys
    // on startedAt and there is only ever one entry.
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 229,
      beforeTokens: 71834,
      afterTokens: 24042,
      compressed: true,
      source: 'command',
      started_at: 1_700_000_000_000,
    })

    expect(store.activeSession!.messages.filter(m => m.compression)).toHaveLength(1)
  })

  it('turns the compressing line into the result rather than adding one', async () => {
    const store = await attach()
    handlers.onCompressionStarted({
      event: 'compression.started',
      session_id: 'session-1',
      message_count: 229,
      token_count: 71834,
      source: 'command',
      started_at: 1_700_000_000_000,
    })
    expect(store.activeSession!.messages.filter(m => m.compression)).toHaveLength(1)
    expect(store.activeSession!.messages.find(m => m.compression)?.compression?.compressing).toBe(true)

    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 229,
      beforeTokens: 71834,
      afterTokens: 24042,
      compressed: true,
      source: 'command',
      started_at: 1_700_000_000_000,
    })

    // Still one line, and it now carries the settled numbers.
    const entries = store.activeSession!.messages.filter(m => m.compression)
    expect(entries).toHaveLength(1)
    expect(entries[0].compression).toMatchObject({ compressing: false, afterTokens: 24042 })
  })

  it('replaces the live entry with the persisted row for the same compression', async () => {
    const store = await attach()
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 229,
      beforeTokens: 71834,
      afterTokens: 24042,
      compressed: true,
      source: 'command',
      started_at: 1_700_000_000_000,
    })
    // A resume brings the server row, keyed on the same startedAt. It must take
    // the live entry's place rather than joining it.
    const session = store.activeSession!
    session.messages.push({
      id: 'server-row-1',
      role: 'system',
      content: '',
      timestamp: 1_700_000_000_000,
      systemType: 'compression',
      compression: {
        compressing: false,
        messageCount: 229,
        beforeTokens: 71834,
        afterTokens: 24042,
        compressed: true,
        source: 'command',
        startedAt: 1_700_000_000_000,
      },
    })
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 229,
      beforeTokens: 71834,
      afterTokens: 24042,
      compressed: true,
      source: 'command',
      started_at: 1_700_000_000_000,
    })

    expect(session.messages.filter(m => m.compression)).toHaveLength(1)
  })

  it('is not duplicated when the compression starts and then completes', async () => {
    const store = await attach()
    handlers.onCompressionStarted({
      event: 'compression.started',
      session_id: 'session-1',
      message_count: 365,
      token_count: 90100,
      started_at: 1_700_000_000_000,
    })
    handlers.onCompressionCompleted({
      event: 'compression.completed',
      session_id: 'session-1',
      totalMessages: 365,
      beforeTokens: 90100,
      afterTokens: 16500,
      compressed: true,
      started_at: 1_700_000_000_000,
    })
    expect(store.activeSession!.messages.filter(m => m.compression)).toHaveLength(1)
  })
})

describe('clearing the tracked state keeps the record', () => {
  /**
   * Asserted at source level on purpose. Every path that actually clears the
   * state -- an idle resume, leaving the session -- also re-fetches or drops the
   * message list, so no behaviour-level test can isolate this rule. A mutation
   * that deletes the entries on clear passes all the store tests above, which is
   * exactly what this catches.
   */
  it('never deletes transcript entries when the state is cleared', () => {
    const source = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')
    const start = source.indexOf('function setCompressionState(')
    const body = source.slice(start, source.indexOf('\n  function ', start + 10))
    expect(body).toContain("recordCompressionEntry(sessionId, state)")
    expect(body).not.toMatch(/else[\s\S]*messages\s*=\s*[^;]*filter\(/)
  })
})

describe('the run indicator no longer owns the compression notice', () => {
  it('renders no compression banner in MessageList', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/MessageList.vue',
      'utf8',
    )
    expect(source).not.toContain('chatStore.compressionState')
  })

  it('recognises a persisted compression row on the way back from the server', () => {
    const source = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')
    // A row the server persisted has to come back as a transcript entry. Without
    // this the record survives in the DB but vanishes from the UI on re-fetch,
    // which is the exact failure the persistence was meant to fix.
    expect(source).toContain("msg.display_role !== 'compression'")
    const start = source.indexOf('const compressionRecord = readCompressionRecord(msg)')
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('continue', start))
    expect(block).toContain("systemType: 'compression'")
  })

  it('collapses the live entry into the persisted row on both resume paths', () => {
    const source = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')
    // The event path merges on its own, but a socket resume replaces the whole
    // message list without firing an event, so those paths have to merge too.
    // Both are identified by the resume payload's `data.messages`, which the
    // deep-link direct fetch does not use.
    expect(source).toContain('function mergePersistedCompressionEntries(')
    const resumeSites = source.split('target.messages = mapHermesMessages(data.messages').length - 1
    expect(resumeSites).toBe(2)
    for (const site of source.split('target.messages = mapHermesMessages(data.messages').slice(1)) {
      expect(site.slice(0, 220)).toContain('mergePersistedCompressionEntries(')
    }
  })

  it('keeps the compression entry out of the retired amber system bubble', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/MessageItem.vue',
      'utf8',
    )
    // role:'system' pulls in .message-bubble.system -- the amber left-striped
    // bubble this fork already retired when it unified the error bubble.
    expect(source).toContain('!props.message.compression')
  })

  it('gives every compression state the one rounded command card', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/MessageItem.vue',
      'utf8',
    )
    // One selector list, so compressing / settled / failed cannot drift apart.
    expect(source).toMatch(/&\.command,\s*\/\/[^]*?&\.compression \{/)
    const start = source.indexOf('&.command,')
    const block = source.slice(start, source.indexOf('}', start))
    expect(block).toContain('border: 1px solid rgba(var(--accent-primary-rgb), 0.12)')
    expect(block).toContain('background-color: rgba(var(--accent-primary-rgb), 0.04)')
    // And the bubble actually opts into it.
    expect(source).toContain('compression: !!props.message.compression')
  })

  it('renders the compression as a transcript entry in MessageItem', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/MessageItem.vue',
      'utf8',
    )
    expect(source).toContain('class="compression-entry"')
    expect(source).toContain('message.compression')
  })
})
