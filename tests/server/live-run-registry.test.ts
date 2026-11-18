// @vitest-environment node
/**
 * A coding-agent child process outlives the server that spawned it.
 *
 * `abort` looks for the run in memory. After a restart there is no such run, so
 * it reports "no active run" and returns -- while the agent keeps burning
 * tokens. The registry is the handle that survives: a pid on disk, scoped to the
 * server process that owns it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  getWebUiHome: () => home.dir,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  registerLiveRun,
  unregisterLiveRun,
  findLiveRun,
  forceKillLiveRun,
  clearLiveRunRegistry,
} from '../../packages/server/src/modules/coding-agents/services/runtime/live-run-registry'

let realKill: typeof process.kill

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'live-run-'))
  realKill = process.kill
})

afterEach(() => {
  process.kill = realKill
  rmSync(home.dir, { recursive: true, force: true })
})

describe('a spawned child is recorded where a fresh process can find it', () => {
  it('round-trips a record by session', () => {
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: process.pid, agentId: 'codex' })
    const found = findLiveRun('s1')
    expect(found?.pid).toBe(process.pid)
    expect(found?.runId).toBe('r1')
    // The owning server is recorded so a crash cannot leave another server's
    // process killable by accident.
    expect(found?.ownerPid).toBe(process.pid)
  })

  it('replaces the entry when the same session respawns', () => {
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: process.pid, agentId: 'codex' })
    registerLiveRun({ sessionId: 's1', runId: 'r2', pid: process.pid, agentId: 'codex' })
    expect(findLiveRun('s1')?.runId).toBe('r2')
  })

  it('drops the entry once the run is unregistered', () => {
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: process.pid, agentId: 'codex' })
    unregisterLiveRun('s1')
    expect(findLiveRun('s1')).toBeNull()
  })

  it('ignores an unregister that names a different run', () => {
    // A late cleanup from the previous run must not remove the live one.
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: process.pid, agentId: 'codex' })
    registerLiveRun({ sessionId: 's1', runId: 'r2', pid: process.pid, agentId: 'codex' })
    unregisterLiveRun('s1', 'r1')
    expect(findLiveRun('s1')?.runId).toBe('r2')
  })
})

describe('a record that cannot be acted on is dropped, not reported', () => {
  it('reports null for a pid that is already gone', () => {
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: 999_999, agentId: 'codex' })
    expect(findLiveRun('s1')).toBeNull()
  })

  it('does not claim a kill it did not perform', () => {
    // The whole failure this registry exists to prevent: a stop that reports
    // success while the agent keeps running.
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: 999_999, agentId: 'codex' })
    const result = forceKillLiveRun('s1')
    expect(result.killed).toBe(false)
  })

  it('does not claim a kill when the pid is gone, even though it was recorded', () => {
    // The failure this guards is a stop that reports success while the agent
    // keeps running. A record existing is not evidence the process exists, so a
    // liveness probe is the only thing between the user and a silently ignored
    // stop.
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: 999_999, agentId: 'codex' })
    const probes: number[] = []
    process.kill = ((pid: number, signal?: string) => {
      if (!signal) probes.push(pid)
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }) as typeof process.kill
    const result = forceKillLiveRun('s1')
    process.kill = realKill
    expect(result.killed).toBe(false)
    // It probed before deciding, rather than trusting the record.
    expect(probes.length).toBeGreaterThan(0)
  })

  it('survives a corrupt registry file instead of throwing', () => {
    clearLiveRunRegistry()
    expect(() => findLiveRun('any')).not.toThrow()
    expect(findLiveRun('any')).toBeNull()
  })
})

describe('a kill reaches the whole process group', () => {
  it('kills the group before the pid, so MCP children do not outlive it', () => {
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: 4242, agentId: 'codex' })
    const calls: Array<[number, string]> = []
    process.kill = ((pid: number, signal?: string) => {
      // Ignore the liveness probe (`signal === 0`): it is the registry asking
      // whether the pid exists, not the kill this test is about.
      if (signal === 'SIGKILL') calls.push([pid, signal])
      return true
    }) as typeof process.kill
    const result = forceKillLiveRun('s1')
    expect(result.killed).toBe(true)
    // Group first (negative pid), then the pid itself.
    expect(calls[0]).toEqual([-4242, 'SIGKILL'])
    expect(calls[1]).toEqual([4242, 'SIGKILL'])
  })

  it('drops the entry after a successful kill', () => {
    registerLiveRun({ sessionId: 's1', runId: 'r1', pid: 4242, agentId: 'codex' })
    process.kill = (() => true) as typeof process.kill
    forceKillLiveRun('s1')
    process.kill = realKill
    expect(findLiveRun('s1')).toBeNull()
  })
})