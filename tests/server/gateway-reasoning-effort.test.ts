import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRunGateway } from '../../packages/server/src/modules/coding-agents/protocol/gateway'
import { resetEffortObservations } from '../../packages/server/src/lib/reasoning-effort-resolve'

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('gateway reasoning_effort adaptation', () => {
  let bodies: Array<Record<string, unknown>>

  beforeEach(() => {
    bodies = []
    resetEffortObservations()
  })

  afterEach(() => vi.unstubAllGlobals())

  const stub = (impl: (attempt: number, body: any) => Response) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      return impl(bodies.length - 1, body)
    }))
  }

  const ok = () => jsonResponse(200, { ok: true })

  it('drops an unsupported level for a provider it knows nothing about', async () => {
    stub(() => ok())
    await agentRunGateway.completeJson({
      url: 'https://api.example/v1/responses',
      apiKey: 'k',
      provider: 'mystery-vendor',
      model: 'mystery-model',
      body: { model: 'mystery-model', reasoning_effort: 'high' },
    })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('keeps a level the deployment accepts', async () => {
    stub(() => ok())
    await agentRunGateway.completeJson({
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: 'k',
      provider: 'deepseek',
      body: { model: 'deepseek-v4', reasoning_effort: 'low' },
    })
    expect(bodies[0].reasoning_effort).toBe('low')
  })

  it('lowers a request above the ceiling instead of failing it', async () => {
    stub(() => ok())
    await agentRunGateway.completeJson({
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: 'k',
      provider: 'deepseek',
      body: { model: 'deepseek-v4', reasoning_effort: 'max' },
    })
    expect(bodies[0].reasoning_effort).toBe('high')
  })

  it('sends no level to Anthropic, which takes a thinking budget', async () => {
    stub(() => ok())
    await agentRunGateway.completeJson({
      url: 'https://api.anthropic.com/v1/messages',
      apiKey: 'k',
      provider: 'anthropic',
      body: { model: 'claude-sonnet-4', reasoning_effort: 'high' },
    })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('retries one rung down when the provider rejects the level outright', async () => {
    stub((attempt) =>
      attempt === 0
        ? jsonResponse(400, { error: { message: 'reasoning_effort_not_supported' } })
        : ok(),
    )
    const result = await agentRunGateway.completeJson({
      url: 'https://api.openai.com/v1/responses',
      apiKey: 'k',
      provider: 'openai',
      body: { model: 'gpt-5', reasoning_effort: 'xhigh' },
    })
    expect(result).toEqual({ ok: true })
    expect(bodies.map(b => b.reasoning_effort)).toEqual(['xhigh', 'high'])
  })

  it('remembers the rejection so the next turn does not repeat it', async () => {
    let rejected = false
    stub(() => {
      if (!rejected) {
        rejected = true
        return jsonResponse(400, { error: { message: 'reasoning_effort_not_supported' } })
      }
      return ok()
    })
    const send = () => agentRunGateway.completeJson({
      url: 'https://api.openai.com/v1/responses',
      apiKey: 'k',
      provider: 'openai',
      body: { model: 'gpt-5', reasoning_effort: 'xhigh' },
    })

    await send()          // xhigh is rejected, retry lands on high
    expect(bodies.map(b => b.reasoning_effort)).toEqual(['xhigh', 'high'])

    await send()          // the next turn must not try xhigh again
    expect(bodies[2].reasoning_effort).toBe('high')
    expect(bodies).toHaveLength(3)
  })

  it('does not retry a failure that is unrelated to reasoning effort', async () => {
    stub(() => jsonResponse(500, { error: { message: 'upstream exploded' } }))
    await expect(
      agentRunGateway.completeJson({
        url: 'https://api.openai.com/v1/responses',
        apiKey: 'k',
        provider: 'openai',
        body: { model: 'gpt-5', reasoning_effort: 'high' },
      }),
    ).rejects.toThrow()
    expect(bodies).toHaveLength(1)
  })

  it('still surfaces the original error body when no lower level applies', async () => {
    stub(() => jsonResponse(400, { error: { message: 'reasoning_effort_not_supported' } }))
    await expect(
      agentRunGateway.completeJson({
        url: 'https://api.deepseek.com/chat/completions',
        apiKey: 'k',
        provider: 'deepseek',
        body: { model: 'deepseek-v4', reasoning_effort: 'minimal' },
      }),
    ).rejects.toThrow('reasoning_effort_not_supported')
  })

  it('leaves a body without the field untouched', async () => {
    stub(() => ok())
    await agentRunGateway.completeJson({
      url: 'https://api.openai.com/v1/responses',
      apiKey: 'k',
      provider: 'openai',
      body: { model: 'gpt-5', input: 'hi' },
    })
    expect(bodies[0]).toEqual({ model: 'gpt-5', input: 'hi' })
  })
})
