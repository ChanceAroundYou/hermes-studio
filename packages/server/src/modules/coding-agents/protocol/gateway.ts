import { openCodeSessionHeaders } from '../../studio/public/opencode-session'
import { openRouterAttributionHeaders } from '../../studio/public/openrouter-attribution'
import {
  decideReasoningEffort,
  noteSupported,
  noteUnsupported,
} from '../../../lib/reasoning-effort-resolve'
import { isReasoningEffortUnsupported, type ReasoningEffort } from '../../../lib/reasoning-effort'

/** A provider request issued by a Coding Agent proxy. */
export interface AgentGatewayRequest {
  url: string
  apiKey: string
  sessionId?: string
  provider?: string
  /** Needed to resolve which reasoning_effort levels this deployment accepts. */
  model?: string
  body: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export class ProviderApiError extends Error {
  status: number
  providerError: unknown

  constructor(status: number, providerError: unknown, message: string) {
    super(message)
    this.name = 'ProviderApiError'
    this.status = status
    this.providerError = providerError
  }
}

export class AgentRunGateway {
  async completeJson<T = any>(request: AgentGatewayRequest): Promise<T> {
    const res = await this.post(request)
    const data = await readProviderJson(res)
    if (!res.ok) throwProviderError(res, data)
    return data as T
  }

  async streamBytes(request: AgentGatewayRequest): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.post(request)
    if (!res.ok) {
      const data = await readProviderJson(res)
      throwProviderError(res, data)
    }
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !/text\/event-stream|application\/x-ndjson|octet-stream/i.test(contentType)) {
      const data = await readProviderJson(res)
      throwProviderError(res, data)
    }
    if (!res.body) throw new Error('Provider returned an empty stream')
    return res.body as any
  }

  private async post(request: AgentGatewayRequest): Promise<Response> {
    // Send the highest level this deployment actually takes. An unknown provider
    // gets no reasoning_effort at all: the requested value is exactly what would
    // fail the turn with reasoning_effort_not_supported.
    const model = resolveModel(request)
    const requested = requestedEffort(request.body)
    const decision = decideReasoningEffort(request.provider, model, requested)
    const send = (body: unknown) =>
      fetch(request.url, {
        method: 'POST',
        headers: {
          ...openCodeSessionHeaders(request.url, request.sessionId, request.provider),
          ...openRouterAttributionHeaders(request.url, request.provider),
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...request.headers,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      })

    const first = applyEffort(request.body, decision, request)
    const res = await send(first.body)
    if (res.ok || !first.applied) {
      if (first.applied) noteSupported(request.provider, model, first.applied)
      return res
    }

    // We own this call, so a rejected level is recoverable. Peek at the failure
    // without consuming the body the caller still needs to read.
    const peeked = await peekFailure(res)
    if (isReasoningEffortUnsupported(peeked)) {
      noteUnsupported(request.provider, model, first.applied)
      const next = decideReasoningEffort(request.provider, model, first.requested)
      if (next.applied && next.applied !== first.applied) {
        const retried = await send(applyEffort(request.body, next, request).body)
        if (retried.ok) noteSupported(request.provider, model, next.applied)
        return retried
      }
    }
    // Put the payload back so the caller's readProviderJson still sees it.
    return res
  }

}

/** Read a failure body without consuming the caller's copy. */
async function peekFailure(res: Response): Promise<unknown> {
  try {
    return await readProviderJson(res.clone())
  } catch {
    return null
  }
}

export async function readProviderJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text || `Provider returned HTTP ${res.status}` } }
  }
}

export function throwProviderError(res: Response, data: any): never {
  throw new ProviderApiError(
    res.status,
    data,
    data?.error?.message || `Provider returned HTTP ${res.status}`,
  )
}

export const agentRunGateway = new AgentRunGateway()

type EffortBody = Record<string, unknown>

function isEffortBody(body: unknown): body is EffortBody {
  return !!body && typeof body === 'object' && !Array.isArray(body)
}

function requestedEffort(body: unknown): string {
  if (!isEffortBody(body)) return ''
  const value = body.reasoning_effort
  return typeof value === 'string' ? value : ''
}

/** Callers do not all pass `model`; the body already carries it in practice. */
function resolveModel(request: AgentGatewayRequest): string | undefined {
  if (request.model) return request.model
  const body = request.body
  if (!isEffortBody(body)) return undefined
  const value = body.model
  return typeof value === 'string' ? value : undefined
}

/** Returns the body to send plus what was actually applied, for the log. */
function applyEffort(
  body: unknown,
  decision: { applied: string; requested: string; adjusted: boolean; reason?: string },
  deployment: { provider?: string; model?: string },
) {
  if (!isEffortBody(body)) return { body, applied: '' as ReasoningEffort | '', requested: decision.requested }
  if (decision.adjusted) {
    console.warn(
      `[reasoning-effort] ${decision.requested} -> ${decision.applied || '(none)'}`
      + ` provider=${deployment.provider ?? ''} model=${deployment.model ?? ''}`
      + ` reason=${decision.reason ?? ''}`,
    )
  }
  const next = { ...body }
  if (decision.applied) next.reasoning_effort = decision.applied
  else delete next.reasoning_effort
  return { body: next, applied: decision.applied as ReasoningEffort | '', requested: decision.requested }
}
