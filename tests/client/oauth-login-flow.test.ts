// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import {
  oauthLoginErrorText,
  useOAuthLoginFlow,
  type OAuthLoginFlowOptions,
} from '@/composables/useOAuthLoginFlow'

/** Mounts the flow inside a component so its lifecycle hooks are real. */
function mountFlow(options: OAuthLoginFlowOptions = {}) {
  let flow!: ReturnType<typeof useOAuthLoginFlow>
  const wrapper = mount(defineComponent({
    setup() {
      flow = useOAuthLoginFlow(options)
      return () => h('div')
    },
  }))
  return { wrapper, flow }
}

describe('useOAuthLoginFlow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on idle and nothing else', () => {
    const { flow } = mountFlow()
    expect(flow.show.value).toBe(true)
    expect(flow.status.value).toBe('idle')
    expect(flow.errorMessage.value).toBe('')
  })

  it('starts loading with a clean error slot', () => {
    const { flow } = mountFlow()
    flow.failQuietly('previous failure')
    expect(flow.status.value).toBe('error')

    flow.begin()
    expect(flow.status.value).toBe('loading')
    expect(flow.errorMessage.value).toBe('')
  })

  it('toasts a failed request but not a poll answer', () => {
    const notifyError = vi.fn()
    const { flow } = mountFlow({ notifyError })

    flow.fail(new Error('boom'))
    expect(flow.status.value).toBe('error')
    expect(flow.errorMessage.value).toBe('boom')
    expect(notifyError).toHaveBeenLastCalledWith('boom')

    // Providers that pre-extract the interesting half hand over a string.
    flow.fail('from the response body')
    expect(flow.errorMessage.value).toBe('from the response body')
    expect(notifyError).toHaveBeenLastCalledWith('from the response body')

    notifyError.mockClear()
    flow.failQuietly('terminal answer from polling')
    expect(flow.status.value).toBe('error')
    expect(flow.errorMessage.value).toBe('terminal answer from polling')
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('polls until the provider approves, then fades out and reports back', async () => {
    const notifySuccess = vi.fn()
    const onApproved = vi.fn()
    const { flow } = mountFlow({
      approvedMessage: () => 'all set',
      notifySuccess,
      onApproved,
    })
    const poll = vi.fn()
      .mockResolvedValueOnce({ kind: 'pending' })
      .mockResolvedValueOnce({ kind: 'approved' })

    flow.sessionId.value = 'sess-1'
    flow.startPolling({ intervalMs: 1_000, poll })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(poll).toHaveBeenLastCalledWith('sess-1')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(flow.status.value).toBe('approved')
    expect(notifySuccess).toHaveBeenCalledWith('all set')

    // approvedDelayMs (1s) then the modal fade (200ms)
    expect(flow.show.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(flow.show.value).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after a dropped response and stops on a terminal one', async () => {
    const { flow } = mountFlow()
    const poll = vi.fn()
      .mockRejectedValueOnce(new Error('socket dropped'))
      .mockResolvedValueOnce({ kind: 'expired' })

    flow.startPolling({ intervalMs: 2_000, poll })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(poll).toHaveBeenCalledTimes(1)
    // A throw is "not yet": still neither failed nor stopped.
    expect(flow.status.value).toBe('idle')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(flow.status.value).toBe('expired')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('reports a failed poll answer as an error state', async () => {
    const notifyError = vi.fn()
    const { flow } = mountFlow({ notifyError })
    const poll = vi.fn().mockResolvedValue({ kind: 'failed', message: 'access denied' })

    flow.startPolling({ intervalMs: 1_000, poll })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(flow.status.value).toBe('error')
    expect(flow.errorMessage.value).toBe('access denied')
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('stops polling as soon as the modal closes', async () => {
    const onClosed = vi.fn()
    const { flow } = mountFlow({ onClosed })
    const poll = vi.fn().mockResolvedValue({ kind: 'pending' })

    flow.startPolling({ intervalMs: 1_000, poll })
    flow.close()
    expect(flow.show.value).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(poll).not.toHaveBeenCalled()
    // The fade delay is measured from close(), so the 5s above already covered it.
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('resets back to idle without a session', () => {
    const { flow } = mountFlow()
    flow.sessionId.value = 'sess-9'
    flow.failQuietly('nope')
    flow.reset()

    expect(flow.status.value).toBe('idle')
    expect(flow.sessionId.value).toBe('')
    expect(flow.errorMessage.value).toBe('')
  })

  it('stops the timer when the component goes away', async () => {
    const { wrapper, flow } = mountFlow()
    const poll = vi.fn().mockResolvedValue({ kind: 'pending' })

    flow.startPolling({ intervalMs: 1_000, poll })
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(poll).not.toHaveBeenCalled()
  })
})

describe('oauthLoginErrorText', () => {
  it('uses a plain message as-is', () => {
    expect(oauthLoginErrorText(new Error('boom'))).toBe('boom')
  })

  it('digs the error field out of a glued response body', () => {
    expect(oauthLoginErrorText(new Error('Request failed: 400 - {"error":"bad device code"}'))).toBe('bad device code')
  })

  it('falls back to the whole message when the body does not parse', () => {
    const raw = 'Request failed: 400 - {not json}'
    expect(oauthLoginErrorText(new Error(raw))).toBe(raw)
  })

  it('falls back when the body carries no usable error field', () => {
    const raw = 'Request failed: 400 - {"detail":"elsewhere"}'
    expect(oauthLoginErrorText(new Error(raw))).toBe(raw)
  })
})
