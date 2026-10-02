import { beforeEach, describe, expect, it } from 'vitest'
import { rememberEffortRejection } from '../../packages/server/src/modules/studio/sockets/chat-run'
import {
  capabilityFor,
  decideReasoningEffort,
  resetEffortObservations,
} from '../../packages/server/src/lib/reasoning-effort-resolve'

/**
 * The chat path cannot retry: the Hermes Agent owns the provider call. So the
 * only chance to react is before the request and after a rejection. These cover
 * both halves, which is exactly what was missing when the first attempt turned
 * out to be a no-op because nothing ever populated the table.
 */
describe('chat path reasoning effort', () => {
  beforeEach(() => resetEffortObservations())

  const run = { provider: 'deepseek', model: 'deepseek-v4', reasoning_effort: 'high' }

  it('learns from a rejection so the next run does not repeat the failure', () => {
    expect(capabilityFor('deepseek', 'deepseek-v4').supported.has('high')).toBe(true)

    rememberEffortRejection(run, new Error('reasoning_effort_not_supported'))

    expect(capabilityFor('deepseek', 'deepseek-v4').supported.has('high')).toBe(false)
    expect(decideReasoningEffort('deepseek', 'deepseek-v4', 'high').applied).toBe('medium')
  })

  it('ignores failures that are not about reasoning effort', () => {
    rememberEffortRejection(run, new Error('upstream 503 service unavailable'))
    expect(capabilityFor('deepseek', 'deepseek-v4').supported.has('high')).toBe(true)
  })

  it('ignores a run that never asked for an effort', () => {
    rememberEffortRejection({ provider: 'deepseek', model: 'deepseek-v4' }, new Error('reasoning_effort_not_supported'))
    expect(capabilityFor('deepseek', 'deepseek-v4').supported.has('high')).toBe(true)
  })

  it('keeps a rejection scoped to its own model', () => {
    rememberEffortRejection(run, new Error('reasoning_effort_not_supported'))
    expect(capabilityFor('deepseek', 'deepseek-v3').supported.has('high')).toBe(true)
  })

  it('accepts the nested error shapes providers actually return', () => {
    rememberEffortRejection(
      { provider: 'openai', model: 'gpt-5', reasoning_effort: 'xhigh' },
      { error: { message: 'reasoning_effort is not supported' } },
    )
    expect(decideReasoningEffort('openai', 'gpt-5', 'xhigh').applied).toBe('high')
  })
})
