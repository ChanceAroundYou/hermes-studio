import type { Context } from 'koa'
import { getChatRunServer } from '../public/chat-run'
import { TaskPlanError } from '../services/task-plan-runs'

export function updateTaskPlan(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const server = getChatRunServer()
  if (!server) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  try {
    const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
    // context_id may be omitted or stale: fall back to this session's CURRENT
    // live context (seeded by begin() at turn start) so the write self-heals.
    const contextId = typeof body.context_id === 'string' && body.context_id.trim()
      ? body.context_id : ''
    const sessionId = typeof body.session_id === 'string' && body.session_id.trim()
      ? body.session_id : undefined
    const plan = server.updateTaskPlan(contextId, profile, body, sessionId)
    ctx.body = { ok: true, ...plan }
  } catch (err) {
    if (!(err instanceof TaskPlanError)) throw err
    ctx.status = err.status
    ctx.body = { ok: false, error: err.message }
  }
}
