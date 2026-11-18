import { afterEach, describe, expect, it, vi } from 'vitest'

const logging = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => logging)

import { ClarificationRuns, CLARIFICATION_TIMEOUT_MS } from '../../packages/server/src/modules/studio/services/clarification-runs'

/** The code a refusal carries, or null when it was accepted after all. */
function codeOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? null
  }
}

function harness() {
  const publish = vi.fn()
  const state = { isWorking: true, isAborting: false, activeRunMarker: 'turn-1' }
  const runs = new ClarificationRuns(publish)
  runs.begin('context-1', 'session-1', 'research', () => state)
  const request = (input = { question: 'Which folder?', choices: ['client', 'server'] }, signal?: AbortSignal) => runs.request('context-1', 'research', input, signal)
  const id = () => publish.mock.calls.filter(call => call[1] === 'clarify.requested').at(-1)![2].clarify_id as string
  return { runs, publish, state, request, id }
}

afterEach(() => vi.useRealTimers())
describe('MCP clarification turns', () => {
  it.each(['client', 'a custom folder', ''])('waits for a choice, free text, or dismissal: %s', async response => {
    const { request, publish, runs, id } = harness()
    const result = request()
    expect(publish).toHaveBeenCalledWith('session-1', 'clarify.requested', expect.objectContaining({
      run_id: 'turn-1', question: 'Which folder?', choices: ['client', 'server'], timeout_ms: 300_000,
    }))
    expect(runs.respond('session-1', id(), response)).toEqual({ handled: true, resolved: true })
    await expect(result).resolves.toEqual({ clarify_id: id(), response, reason: response ? 'response' : 'dismissed' })
    expect(runs.respond('session-1', id(), 'duplicate').handled).toBe(false)
  })

  it('rejects another profile/session and an unknown context', async () => {
    const { request, runs, id } = harness()
    expect(codeOf(() => runs.request('context-1', 'other', { question: 'Q' }))).toBe('context_wrong_profile')
    expect(codeOf(() => runs.request('old-context', 'research', { question: 'Q' }))).toBe('context_unknown')
    const result = request()
    expect(runs.respond('other-session', id(), 'wrong')).toEqual({ handled: true, resolved: false })
    runs.respond('session-1', id(), 'correct')
    await expect(result).resolves.toMatchObject({ response: 'correct' })
  })

  it.each([{ question: '' }, { question: 'x'.repeat(4001) }, { question: 'Q', choices: [123] },
    { question: 'Q', choices: [' '] }, { question: 'Q', choices: ['x'.repeat(501)] },
    { question: 'Q', choices: Array(21).fill('a') }])('validates input before displaying a prompt: %j', input => {
    const { runs, publish } = harness()
    expect(() => runs.request('context-1', 'research', input)).toThrow()
    expect(publish).not.toHaveBeenCalled()
  })

  it('times out without manufacturing an answer and allows a later question', async () => {
    vi.useFakeTimers()
    const { request, runs, id } = harness()
    const result = request()
    await vi.advanceTimersByTimeAsync(CLARIFICATION_TIMEOUT_MS)
    await expect(result).resolves.toMatchObject({ response: '', reason: 'timeout' })
    expect(runs.respond('session-1', id(), 'late').handled).toBe(false)
    const next = request()
    runs.finishSession('session-1')
    await expect(next).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it("leaves an older turn's prompt alone when the next turn begins", async () => {
    // B: cancelling on "a new turn started" is the sweep that made a prompt
    // vanish (or, worse, stay on screen unanswerable) while its own turn was
    // still the one that owned it. A prompt is settled by *its own* turn ending.
    const { runs, request, state, publish } = harness()
    const result = request()
    const firstId = publish.mock.calls.filter(call => call[1] === 'clarify.requested').at(-1)![2].clarify_id as string
    state.activeRunMarker = 'turn-2'
    runs.begin('context-2', 'session-1', 'research', () => state)

    const settled = publish.mock.calls.filter(call => call[1] === 'clarify.resolved').map(call => call[2].clarify_id)
    expect(settled).not.toContain(firstId)

    // Its own turn is no longer live, so answering it is refused...
    expect(() => request()).toThrow('active turn')
    // ...while the new turn's prompt is entirely independent.
    const next = runs.request('context-2', 'research', { question: 'New question' })
    expect(next).toBeInstanceOf(Promise)

    runs.finishSession('session-1', 'context-1')
    await expect(result).resolves.toMatchObject({ reason: 'cancelled' })
    runs.finishSession('session-1', 'context-2')
    await expect(next).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('lets one session wait on two prompts at once', async () => {
    const { runs, publish, request, id } = harness()
    const first = request({ question: 'Which folder?' })
    const second = request({ question: 'And which branch?' })
    const requested = publish.mock.calls.filter(call => call[1] === 'clarify.requested')
    expect(requested).toHaveLength(2)
    expect(requested[0][2].question).toBe('Which folder?')
    expect(requested[1][2].question).toBe('And which branch?')

    expect(runs.respond('session-1', id(), 'main')).toEqual({ handled: true, resolved: true })
    await expect(second).resolves.toMatchObject({ clarify_id: id(), response: 'main', reason: 'response' })
    // Answering the newer prompt must not touch the older one.
    expect(publish.mock.calls.filter(call => call[1] === 'clarify.resolved')).toHaveLength(1)

    const firstId = requested[0][2].clarify_id as string
    expect(runs.respond('session-1', firstId, 'src')).toEqual({ handled: true, resolved: true })
    await expect(first).resolves.toMatchObject({ clarify_id: firstId, response: 'src', reason: 'response' })
  })

  it("settles only the prompts raised by the turn that ended", async () => {
    const { runs, publish, request, state } = harness()
    const first = request({ question: 'From turn one' })
    const firstId = publish.mock.calls.filter(call => call[1] === 'clarify.requested')[0][2].clarify_id as string
    state.activeRunMarker = 'turn-2'
    runs.begin('context-2', 'session-1', 'research', () => state)
    const second = runs.request('context-2', 'research', { question: 'From turn two' })
    const secondId = publish.mock.calls.filter(call => call[1] === 'clarify.requested')[1][2].clarify_id as string

    runs.finishSession('session-1', 'context-1')

    await expect(first).resolves.toMatchObject({ clarify_id: firstId, reason: 'cancelled' })
    const settled = publish.mock.calls.filter(call => call[1] === 'clarify.resolved')
    expect(settled.map(call => call[2].clarify_id)).toEqual([firstId])

    // The surviving prompt is still answerable by its own turn.
    expect(runs.respond('session-1', secondId, 'yes')).toEqual({ handled: true, resolved: true })
    await expect(second).resolves.toMatchObject({ clarify_id: secondId, response: 'yes', reason: 'response' })
  })

  it('cancels on transport disconnect and rejects answers after abort or run replacement', async () => {
    const { request, runs, state, id } = harness()
    const abort = new AbortController()
    const result = request(undefined, abort.signal)
    abort.abort()
    await expect(result).resolves.toMatchObject({ reason: 'cancelled' })
    const next = request()
    state.isAborting = true
    expect(() => request()).toThrow('active turn')
    expect(runs.respond('session-1', id(), 'late')).toEqual({ handled: true, resolved: false })
    await expect(next).resolves.toMatchObject({ reason: 'cancelled', response: '' })
    state.isAborting = false
    state.activeRunMarker = 'changed'
    expect(() => request()).toThrow('active turn')
  })
})

/**
 * Every refusal used to be a bare 409 with nothing written down, which is why
 * "the prompt never showed up" could not be told apart from "the prompt was
 * refused". The code is what the caller can act on; the log is what a later
 * investigation can read.
 */
describe('why a prompt was refused', () => {
  it('separates an expired turn from an expired context', () => {
    const { runs, state } = harness()
    state.isWorking = false
    expect(codeOf(() => runs.request('context-1', 'research', { question: 'Q' }))).toBe('context_no_active_turn')

    const { runs: aborting, state: abortingState } = harness()
    abortingState.isAborting = true
    expect(codeOf(() => aborting.request('context-1', 'research', { question: 'Q' }))).toBe('context_no_active_turn')

    const { runs: replaced, state: replacedState } = harness()
    replacedState.activeRunMarker = 'turn-2'
    replaced.request('context-1', 'research', { question: 'first' })
    replacedState.activeRunMarker = 'turn-3'
    expect(codeOf(() => replaced.request('context-1', 'research', { question: 'Q' }))).toBe('context_no_active_turn')

    const { runs: cancelled } = harness()
    const controller = new AbortController()
    controller.abort()
    expect(codeOf(() => cancelled.request('context-1', 'research', { question: 'Q' }, controller.signal))).toBe('request_aborted')

    const { runs: live } = harness()
    expect(codeOf(() => live.request('context-1', 'research', { question: '' }))).toBe('invalid_request')
  })

  it('writes down the context it could not use, with the session it belonged to', () => {
    const { runs, state } = harness()
    state.isWorking = false
    codeOf(() => runs.request('context-1', 'research', { question: 'Q' }))

    expect(logging.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'context_no_active_turn', contextId: 'context-1', sessionId: 'session-1', profile: 'research',
      }),
      expect.stringContaining('clarification'),
    )
  })

  it('writes down an unknown context even though no session owns it', () => {
    const { runs } = harness()
    logging.logger.warn.mockClear()
    codeOf(() => runs.request('gone', 'research', { question: 'Q' }))

    expect(logging.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'context_unknown', contextId: 'gone', profile: 'research' }),
      expect.stringContaining('clarification'),
    )
  })

  it('stays quiet when the request is accepted', () => {
    const { runs } = harness()
    logging.logger.warn.mockClear()
    void runs.request('context-1', 'research', { question: 'Q' })
    expect(logging.logger.warn).not.toHaveBeenCalled()
  })
})
