import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateTaskPlan } from '../../packages/server/src/modules/studio/controllers/task-plans'
import { setChatRunServer } from '../../packages/server/src/modules/studio/services/chat-run/server-registry'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'

afterEach(() => setChatRunServer(null))
describe('task plan HTTP controller', () => {
  it('binds updates to the authenticated profile, ignoring caller-supplied session and run ids', () => {
    const runs = new TaskPlanRuns(vi.fn(), vi.fn())
    const contextId = runs.begin('owned-session', 'research', () => ({ isWorking: true, activeRunMarker: 'owned-turn' }))
    setChatRunServer({ updateTaskPlan: runs.update.bind(runs) })
    const ctx = {
      state: { profile: { name: 'research' } }, status: 200, body: undefined as any,
      request: { body: { context_id: contextId, session_id: 'other-session', run_id: 'other-turn',
        plan: [{ id: 'check', step: 'Check changes', status: 'in_progress' }] } },
    }
    updateTaskPlan(ctx as any)
    expect(ctx.body).toMatchObject({ ok: true, session_id: 'owned-session', run_id: 'owned-turn', revision: 1 })
    ctx.state.profile.name = 'other'
    updateTaskPlan(ctx as any)
    expect(ctx.status).toBe(409)
    ctx.state.profile.name = 'research'
    // An empty context_id no longer 400s: it falls back to the session's LIVE
    // context — but only a session that actually has one. 'other-session'
    // (the spoofed caller-supplied id) has no live binding, so the write still
    // 409s; the owner's session id self-heals.
    ctx.request.body.context_id = ''
    ctx.request.body.session_id = 'other-session'
    updateTaskPlan(ctx as any)
    expect(ctx.status).toBe(409)
    ctx.request.body.context_id = ''
    ctx.request.body.session_id = 'owned-session'
    updateTaskPlan(ctx as any)
    expect(ctx.body).toMatchObject({ ok: true, session_id: 'owned-session', run_id: 'owned-turn', revision: 2 })
  })

  it('reports unavailable runtime without accepting a plan', () => {
    const ctx = { state: {}, request: { body: {} }, status: 200, body: undefined as any }
    updateTaskPlan(ctx as any)
    expect(ctx.status).toBe(503)
  })
})
