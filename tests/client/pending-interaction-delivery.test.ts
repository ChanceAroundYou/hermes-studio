// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connected: false, io: {} })),
}))
vi.mock('@/api/client', () => ({
  getApiKey: () => 'token', getBaseUrlValue: () => '', getActiveProfileName: () => 'default',
}))

import {
  dispatchPendingInteractionEvent,
  onPeerUserMessage,
  registerSessionHandlers,
} from '@/api/studio/chat'

const event = {
  event: 'clarify.requested', session_id: 's1', clarify_id: 'c1', question: 'Which folder?',
} as any

function handlersWith(overrides: Record<string, unknown>) {
  const noop = () => undefined
  return {
    onMessageDelta: noop, onMessageInterim: noop, onReasoningDelta: noop, onThinkingDelta: noop,
    onReasoningAvailable: noop, onToolStarted: noop, onToolCompleted: noop, onRunStarted: noop,
    onRunCompleted: noop, onRunFailed: noop, onCompressionStarted: noop, onCompressionCompleted: noop,
    onAbortStarted: noop, onAbortCompleted: noop, onUsageUpdated: noop,
    ...overrides,
  } as any
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  vi.clearAllMocks()
})

/**
 * One prompt, one reader.
 *
 * The session-scoped handler and the peer fan-out both end in `setPendingClarify`,
 * so firing both wrote the same prompt twice: the countdown restarted, the card
 * was re-announced, and any per-arrival bookkeeping ran on a duplicate.
 */
describe('one pending prompt, one delivery', () => {
  it('does not hand the same prompt to both readers', () => {
    const sessionHandler = vi.fn()
    const peerHandler = vi.fn()
    cleanups.push(registerSessionHandlers('s1', handlersWith({ onClarifyRequested: sessionHandler })))
    cleanups.push(onPeerUserMessage(peerHandler))

    dispatchPendingInteractionEvent('s1', handlers => handlers.onClarifyRequested, event)

    expect(sessionHandler).toHaveBeenCalledTimes(1)
    expect(peerHandler).not.toHaveBeenCalled()
  })

  it('still delivers to the peer reader when nobody has the session open', () => {
    const peerHandler = vi.fn()
    cleanups.push(onPeerUserMessage(peerHandler))

    dispatchPendingInteractionEvent('s-closed', handlers => handlers.onClarifyRequested, event)

    expect(peerHandler).toHaveBeenCalledTimes(1)
    expect(peerHandler).toHaveBeenCalledWith(event)
  })

  it('falls back to the peer reader when the open session does not want this event', () => {
    // A session registers one handler set for every event type; a type it did
    // not wire up must not silently swallow the delivery.
    const peerHandler = vi.fn()
    cleanups.push(registerSessionHandlers('s1', handlersWith({ onClarifyRequested: vi.fn() })))
    cleanups.push(onPeerUserMessage(peerHandler))

    dispatchPendingInteractionEvent('s1', handlers => handlers.onClarifyResolved, event)

    expect(peerHandler).toHaveBeenCalledTimes(1)
  })

  it('drops an event with no session id', () => {
    const peerHandler = vi.fn()
    cleanups.push(onPeerUserMessage(peerHandler))

    dispatchPendingInteractionEvent(undefined, handlers => handlers.onClarifyRequested, event)

    expect(peerHandler).not.toHaveBeenCalled()
  })
})
