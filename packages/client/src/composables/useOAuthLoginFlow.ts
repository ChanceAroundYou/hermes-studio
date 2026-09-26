import { onUnmounted, ref, type Ref } from 'vue'
import { errorMessage as errorMessageOf } from '@/utils/format'

export type OAuthLoginStatus =
  | 'idle'
  | 'loading'
  | 'waiting'
  | 'submitting'
  | 'approved'
  | 'expired'
  | 'error'

/** What one poll of a provider's login session reported. */
export type OAuthPollOutcome =
  | { kind: 'pending' }
  | { kind: 'approved' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string }

export interface OAuthPollOptions {
  /** Gap between polls. */
  intervalMs: number
  /** One poll. A throw means "not yet", and is rescheduled. */
  poll: (sessionId: string) => Promise<OAuthPollOutcome>
}

export interface OAuthLoginFlowOptions {
  /** Toast hooks, so the flow itself stays independent of the UI framework. */
  notifySuccess?: (text: string) => void
  notifyError?: (text: string) => void
  /** Text toasted once the provider approves the login. */
  approvedMessage?: () => string
  /** How long the approved state stays on screen. */
  approvedDelayMs?: number
  /** The modal fade before the parent hears about it. */
  closeDelayMs?: number
  /** After the approved state finished fading out. */
  onApproved?: () => void
  /** After the modal finished fading out. */
  onClosed?: () => void
}

/**
 * The login state machine the six provider OAuth modals used to each carry a
 * copy of (nine functions and about a hundred lines apiece).
 *
 * What stays with the provider is genuinely per provider: the two API calls and
 * how a poll answer maps onto `OAuthPollOutcome` - a 'denied' answer is a
 * Copilot/Nous thing, a pasted code is an Anthropic thing. Everything else -
 * the timer, the retry after a throwing poll, the approve/close/retry sequence
 * with its fades, and the unmount cleanup - lives here once.
 */
export function useOAuthLoginFlow(options: OAuthLoginFlowOptions = {}) {
  const {
    notifySuccess,
    notifyError,
    approvedMessage,
    approvedDelayMs = 1_000,
    closeDelayMs = 200,
    onApproved,
    onClosed,
  } = options

  const show = ref(true)
  const status = ref<OAuthLoginStatus>('idle')
  const sessionId = ref('')
  const errorMessage = ref('')
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  /** Enter the loading state and drop the previous failure. */
  function begin() {
    status.value = 'loading'
    errorMessage.value = ''
  }

  /**
   * A failed request: shown, toasted, and retryable. Pass a string when the
   * provider already extracted the interesting half of the response.
   */
  function fail(error: unknown) {
    status.value = 'error'
    errorMessage.value = typeof error === 'string' ? error : errorMessageOf(error)
    notifyError?.(errorMessage.value)
  }

  /** A terminal answer that arrived through polling: shown, not toasted. */
  function failQuietly(text: string) {
    status.value = 'error'
    errorMessage.value = text
  }

  function expire() {
    status.value = 'expired'
  }

  function approve() {
    stopPolling()
    status.value = 'approved'
    const text = approvedMessage?.()
    if (text) notifySuccess?.(text)
    setTimeout(() => {
      show.value = false
      setTimeout(() => onApproved?.(), closeDelayMs)
    }, approvedDelayMs)
  }

  function close() {
    stopPolling()
    show.value = false
    setTimeout(() => onClosed?.(), closeDelayMs)
  }

  /** Back to idle with no session; the caller decides whether to start again. */
  function reset() {
    stopPolling()
    status.value = 'idle'
    sessionId.value = ''
    errorMessage.value = ''
  }

  function startPolling({ intervalMs, poll }: OAuthPollOptions): void {
    stopPolling()
    pollTimer = setTimeout(async () => {
      let outcome: OAuthPollOutcome
      try {
        outcome = await poll(sessionId.value)
      } catch {
        startPolling({ intervalMs, poll })
        return
      }
      if (outcome.kind === 'pending') startPolling({ intervalMs, poll })
      else if (outcome.kind === 'approved') approve()
      else if (outcome.kind === 'expired') expire()
      else failQuietly(outcome.message)
    }, intervalMs)
  }

  onUnmounted(stopPolling)

  return {
    show: show as Ref<boolean>,
    status: status as Ref<OAuthLoginStatus>,
    sessionId: sessionId as Ref<string>,
    errorMessage,
    begin,
    fail,
    failQuietly,
    expire,
    approve,
    close,
    reset,
    startPolling,
    stopPolling,
  }
}

/**
 * Some providers answer a failed start with the raw response body glued to the
 * message; when it parses, its `error` field is the useful half.
 */
export function oauthLoginErrorText(error: unknown): string {
  const text = errorMessageOf(error)
  const match = text.match(/\{[\s\S]*\}$/)
  if (!match) return text
  try {
    const body = JSON.parse(match[0]) as { error?: unknown }
    return typeof body.error === 'string' && body.error.trim() ? body.error : text
  } catch {
    return text
  }
}
