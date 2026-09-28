// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isBridgeFailureText } from '@/stores/hermes/chat'

/**
 * One real failure used to render twice in two styles. The bridge streamed
 * "Non-retryable error (HTTP 502): ..." as a status *text*, which the client
 * rendered as a neutral amber system notice; the server then persisted the same
 * failure as a `role: 'error'` row that renders red. The transcript visibly
 * jumped from amber to red for a single run.
 *
 * An earlier attempt classified on the message body inside MessageItem and
 * repainted ordinary replies red ("Error handling in the parser looks correct",
 * "The failed test was flaky"). These assertions pin both halves of the fix:
 * the real bridge failure is caught, and normal prose is not.
 */
describe('bridge failure text detection', () => {
  it('recognises the real failure from the reported screenshot', () => {
    const real = 'Non-retryable error (HTTP 502): HTTP 502: Provider returned 400 Bad Request: {"error":{"code":"reasoning_effort_not_supported","message":"reasoning effort \'max\' is not supported by the loaded chat template","param":"reasoning_effort","type":"invalid_request_error"}}'
    expect(isBridgeFailureText(real)).toBe(true)
  })

  it('recognises the other machine-generated failure signatures', () => {
    for (const text of [
      'Error: Agent returned no output. The model call may have failed.',
      'run failed',
      'Run failed to start',
      'Agent run failed',
      'Agent reported failure',
      'HTTP 500: internal error',
      'HTTP 404: not found',
      'HTTP 401: Unauthorized',
      'fatal: cannot continue',
      'Provider returned 400 Bad Request',
      'Failed to start the bridge process',
      'Traceback (most recent call last):',
      // No HTTP code and no provider wording: only the "Non-retryable" prefix
      // can match this, so removing that pattern fails here.
      'Non-retryable error: the model refused the request',
    ]) {
      expect(isBridgeFailureText(text), text).toBe(true)
    }
  })

  it('never flags ordinary replies or status chatter', () => {
    // This list is the regression guard for the over-broad classifier: every
    // one of these reads like ordinary output and must stay unstyled.
    for (const text of [
      '',
      '   ',
      'Here is the diff you asked for.',
      'Error handling in the parser looks correct to me.',
      'The failed test was flaky, retrying helped.',
      'Your build failed on my machine but works in CI.',
      'The script failed to parse because of a missing brace, so I fixed it.',
      'Let me look at the error handling code.',
      'The timeout error handling looks fine.',
      'No errors were found in the log.',
      'Compression completed: 666 -> 9 messages, 303366 -> 42924 tokens.',
      '/compact',
      'Task plan updated: 3 steps.',
      'All tests passed.',
      'The request succeeded.',
      'The timeout value is set to 30 seconds in config.',
      'HTTP is used by the transcript protocol.',
      'HTTP 200 OK returned by the health check.',
      'Tool finished: read 12 lines.',
      'Search returned 0 results.',
    ]) {
      expect(isBridgeFailureText(text), JSON.stringify(text)).toBe(false)
    }
  })
})
