import { beforeEach, describe, expect, it } from 'vitest'
import {
  isReasoningEffortUnsupported,
  pickSupported,
  stepDown,
} from '../../packages/server/src/lib/reasoning-effort'
import { staticCapability } from '../../packages/server/src/lib/reasoning-effort-capabilities'
import {
  capabilityFor,
  decideReasoningEffort,
  noteSupported,
  noteUnsupported,
  resetEffortObservations,
  withReasoningEffortFallback,
} from '../../packages/server/src/lib/reasoning-effort-resolve'

describe('reasoning effort ladder', () => {
  it('steps down one rung and stops below none', () => {
    expect(stepDown('max')).toBe('xhigh')
    expect(stepDown('high')).toBe('medium')
    expect(stepDown('minimal')).toBe('none')
    expect(stepDown('none')).toBe('')
  })

  it('never picks a level above the request', () => {
    const supported = new Set(['minimal', 'low', 'medium', 'high'])
    expect(pickSupported('max', supported)).toBe('high')
    expect(pickSupported('low', supported)).toBe('low')
    expect(pickSupported('minimal', new Set(['high']))).toBe('')
  })
})

describe('static capability table', () => {
  it('treats medium/high as unconditional but xhigh/max as opt-in', () => {
    const gpt5 = staticCapability('openai', 'gpt-5')
    expect(gpt5.supported.has('medium')).toBe(true)
    expect(gpt5.supported.has('high')).toBe(true)
    expect(gpt5.supported.has('max')).toBe(false)
  })

  it('keeps none/minimal away from o-series', () => {
    const o = staticCapability('openai', 'o3-mini')
    expect(o.supported.has('none')).toBe(false)
    expect(o.supported.has('minimal')).toBe(false)
    expect(o.supported.has('high')).toBe(true)
  })

  it('gives Anthropic no effort enum instead of guessing a mapping', () => {
    const anthropic = staticCapability('anthropic', 'claude-sonnet-4')
    expect(anthropic.supported.size).toBe(0)
    expect(anthropic.reason).toContain('thinking budget')
  })

  it('resolves an unknown deployment to nothing known, not to defaults', () => {
    const unknown = staticCapability('some-new-vendor', 'mystery-model')
    expect(unknown.source).toBe('unknown')
    expect(unknown.supported.size).toBe(0)
  })

  it('infers from the model behind an OpenRouter prefix', () => {
    const routed = staticCapability('openrouter', 'openai/gpt-5')
    expect(routed.supported.has('xhigh')).toBe(true)
    expect(staticCapability('openrouter', 'anthropic/claude-3').supported.size).toBe(0)
  })
})

describe('decision is fail-closed', () => {
  beforeEach(() => resetEffortObservations())

  it('sends nothing for a deployment we know nothing about', () => {
    const decision = decideReasoningEffort('some-new-vendor', 'mystery', 'max')
    expect(decision.applied).toBe('')
    expect(decision.adjusted).toBe(true)
  })

  it('sends nothing to Anthropic rather than an invalid level', () => {
    expect(decideReasoningEffort('anthropic', 'claude-sonnet-4', 'high').applied).toBe('')
  })

  it('honours a level the deployment supports', () => {
    const decision = decideReasoningEffort('deepseek', 'deepseek-v4', 'low')
    expect(decision.applied).toBe('low')
    expect(decision.adjusted).toBe(false)
  })

  it('downgrades instead of failing when the request is above the ceiling', () => {
    const decision = decideReasoningEffort('deepseek', 'deepseek-v4', 'max')
    expect(decision.applied).toBe('high')
    expect(decision.adjusted).toBe(true)
    expect(decision.reason).toContain('max')
  })

  it('records what a rejection taught us and stops sending it', () => {
    noteUnsupported('deepseek', 'deepseek-v4', 'high')
    const after = capabilityFor('deepseek', 'deepseek-v4')
    expect(after.supported.has('high')).toBe(false)
    expect(after.supported.has('medium')).toBe(true)
    expect(decideReasoningEffort('deepseek', 'deepseek-v4', 'high').applied).toBe('medium')
  })

  it('does not let an observation leak across models', () => {
    noteUnsupported('deepseek', 'deepseek-v4', 'high')
    expect(capabilityFor('deepseek', 'deepseek-v3').supported.has('high')).toBe(true)
  })

  it('keeps an explicitly unsupported level off the table even if seen working', () => {
    noteSupported('openai', 'gpt-5', 'max')
    expect(capabilityFor('openai', 'gpt-5').supported.has('max')).toBe(false)
  })
})

describe('provider error recognition', () => {
  it('matches the shapes providers use', () => {
    expect(isReasoningEffortUnsupported(new Error('reasoning_effort_not_supported'))).toBe(true)
    expect(isReasoningEffortUnsupported({ error: { message: 'reasoning_effort is not supported' } })).toBe(true)
    expect(isReasoningEffortUnsupported(new Error('unsupported value: reasoning effort'))).toBe(true)
    expect(isReasoningEffortUnsupported({ body: JSON.stringify({ detail: 'invalid reasoning_effort: max' }) })).toBe(true)
  })

  it('does not swallow unrelated failures', () => {
    expect(isReasoningEffortUnsupported(new Error('ECONNREFUSED'))).toBe(false)
    expect(isReasoningEffortUnsupported(new Error('rate limit exceeded'))).toBe(false)
    expect(isReasoningEffortUnsupported(null)).toBe(false)
  })
})

describe('retry on paths that own the provider call', () => {
  beforeEach(() => resetEffortObservations())

  it('steps down and retries, then remembers the level that worked', async () => {
    const seen: string[] = []
    const result = await withReasoningEffortFallback(
      async effort => {
        seen.push(effort)
        if (effort === 'xhigh') throw new Error('reasoning_effort_not_supported')
        return `ok:${effort}`
      },
      { provider: 'openai', model: 'gpt-5', effort: 'xhigh' },
    )
    expect(result).toBe('ok:high')
    expect(seen).toEqual(['xhigh', 'high'])
    expect(decideReasoningEffort('openai', 'gpt-5', 'xhigh').applied).toBe('high')
  })

  it('rethrows anything that is not an effort rejection', async () => {
    await expect(
      withReasoningEffortFallback(
        async () => { throw new Error('upstream 503') },
        { provider: 'openai', model: 'gpt-5', effort: 'high' },
      ),
    ).rejects.toThrow('upstream 503')
  })

  it('gives up rather than looping when every level is rejected', async () => {
    const attempts: string[] = []
    await expect(
      withReasoningEffortFallback(
        async effort => {
          attempts.push(effort)
          throw new Error('reasoning_effort_not_supported')
        },
        { provider: 'openai', model: 'gpt-5', effort: 'xhigh', maxAttempts: 3 },
      ),
    ).rejects.toThrow('reasoning_effort_not_supported')
    expect(attempts.length).toBe(3)
  })

  it('sends no effort at all when the deployment is unknown', async () => {
    const seen: string[] = []
    await withReasoningEffortFallback(
      async effort => { seen.push(effort); return 'ok' },
      { provider: 'mystery-vendor', model: 'mystery', effort: 'high' },
    )
    expect(seen).toEqual([''])
  })
})
