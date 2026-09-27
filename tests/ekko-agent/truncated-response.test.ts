import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src'
import type { ModelClient, ModelRequest, ModelResponse } from '../../packages/ekko-agent/src'

/**
 * A provider cut at the output limit answers with `finishReason: 'length'` and no
 * tool call. That used to read as a finished answer, so the turn ended on a
 * truncated message; the runtime now asks the model to continue.
 */
function clientReturning(responses: ModelResponse[], requests: ModelRequest[]): ModelClient {
  return {
    provider: 'truncation-test',
    requestStyle: 'openai-chat',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async (request: ModelRequest) => {
      requests.push(request)
      return responses.shift() ?? { content: 'fallback', finishReason: 'stop' }
    }),
    stream: vi.fn(),
  }
}

function runtimeFor(responses: ModelResponse[], requests: ModelRequest[]) {
  return new AgentRuntime({
    modelClient: clientReturning(responses, requests),
    tools: new AgentToolRegistry(),
  })
}

describe('truncated model responses', () => {
  it('continues the turn instead of ending it on a cut-off answer', async () => {
    const requests: ModelRequest[] = []
    const runtime = runtimeFor([
      { content: 'Here is the first half of the answer', finishReason: 'length' },
      { content: 'and here is the rest of it.', finishReason: 'stop' },
    ], requests)

    const result = await runtime.run({ messages: ['Explain the whole thing.'] })

    expect(requests).toHaveLength(2)
    expect(result.output.content).toBe('and here is the rest of it.')
    // The retry carries a nudge so the model resumes rather than starting over.
    const nudge = requests[1].messages.map(message => String(message.content)).join('\n')
    expect(nudge).toContain('cut off by the output limit')
  })

  it('gives up after the continuation limit so a stuck provider cannot loop forever', async () => {
    const requests: ModelRequest[] = []
    const runtime = runtimeFor([
      { content: 'cut 1', finishReason: 'length' },
      { content: 'cut 2', finishReason: 'length' },
      { content: 'cut 3', finishReason: 'length' },
      { content: 'cut 4', finishReason: 'length' },
    ], requests)

    const result = await runtime.run({ messages: ['Keep going.'] })

    expect(requests).toHaveLength(4)
    expect(result.output.content).toBe('cut 4')
  })

  it('does not treat a normal answer without tool calls as truncated', async () => {
    const requests: ModelRequest[] = []
    const runtime = runtimeFor([{ content: 'A complete answer.', finishReason: 'stop' }], requests)

    const result = await runtime.run({ messages: ['Answer briefly.'] })

    expect(requests).toHaveLength(1)
    expect(result.output.content).toBe('A complete answer.')
  })
})
