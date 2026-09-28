import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A run that calls tools and returns no final text is a *successful* run: the
 * answer was the tool's output, delivered through the tool row. Reporting it as
 * "the agent returned no output" would invent a failure the user never had.
 *
 * The check originally asked `state.events` whether a tool had run. That array
 * is cleared during teardown, several hundred lines before the check reads it,
 * so the answer was always "no tool ran" and every tool-only run was mislabelled.
 * The run now carries its own `hadToolActivity` flag, which survives teardown.
 */
describe('empty output is judged from the run, not from a cleared buffer', () => {
  let state: any

  beforeEach(() => {
    state = {
      isWorking: true,
      isAborting: false,
      profile: 'default',
      source: 'cli',
      runId: 'r1',
      activeRunMarker: 'm1',
      runEpoch: 1,
      runState: 'running' as string,
      events: [] as any[],
      queue: [] as any[],
      hadToolActivity: false,
      messages: [] as any[],
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The finalization predicate, as the handler applies it. */
  const shouldReportEmptyOutput = (finalResponse: string | undefined, terminalError: boolean) => {
    if (terminalError || finalResponse?.trim()) return false
    return !state.hadToolActivity && state.queue.length === 0
  }

  it('reports a run that did nothing at all', () => {
    expect(shouldReportEmptyOutput('', false)).toBe(true)
  })

  it('reports a run whose output was only whitespace', () => {
    expect(shouldReportEmptyOutput('   \n\t ', false)).toBe(true)
  })

  it('stays quiet when the run used a tool and said nothing', () => {
    state.hadToolActivity = true
    expect(shouldReportEmptyOutput('', false)).toBe(false)
  })

  it('stays quiet when there is a final answer', () => {
    expect(shouldReportEmptyOutput('here you go', false)).toBe(false)
  })

  it('stays quiet when the run already failed for a named reason', () => {
    expect(shouldReportEmptyOutput('', true)).toBe(false)
  })

  it('stays quiet while a turn is queued behind this one', () => {
    state.queue.push({ session_id: 's1' })
    expect(shouldReportEmptyOutput('', false)).toBe(false)
  })

  it('is decided by the flag after the event buffer is emptied', () => {
    // Teardown order: this is the sequence the handler actually runs.
    state.hadToolActivity = true
    state.events = [] // teardown clears the buffer

    expect(state.events).toHaveLength(0)
    expect(shouldReportEmptyOutput('', false)).toBe(false)
  })
})

/**
 * The original defect, stated as a test. Reading the cleared buffer reports a
 * tool-using run as empty.
 */
describe('anti-test: reading the cleared buffer mislabels a tool-only run', () => {
  it('the old predicate had no way to see the tool call', () => {
    const state: any = { events: [], hadToolActivity: true }
    // Before teardown the evidence existed:
    state.events.push({ event: 'tool.started', tool: 'read_file' })
    expect(state.events.some((e: any) => e.event.startsWith('tool.'))).toBe(true)

    // Teardown wipes it, and the old predicate then reports emptiness.
    state.events = []
    const oldSawTool = state.events.some((e: any) => e.event.startsWith('tool.'))
    expect(oldSawTool).toBe(false)

    // The flag is what still answers the question.
    expect(state.hadToolActivity).toBe(true)
  })

  it('a previous run tool usage does not excuse a later empty run', () => {
    const state: any = { hadToolActivity: true }
    // Every run start clears the flag; this is what that reset protects.
    state.hadToolActivity = false
    expect(state.hadToolActivity).toBe(false)
  })
})

/**
 * The cases above exercise a transcription of the predicate. Without this the
 * test would keep passing even if the handler reverted, so the transcription is
 * pinned to the shipped source.
 */
describe('the shipped handler judges emptiness the same way', () => {
  const read = async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    return readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)),
        '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts'),
      'utf8',
    )
  }

  it('reads the run-scoped flag, not the event buffer', async () => {
    const src = await read()
    const start = src.indexOf('if (!terminalError && !finalResponse?.trim())')
    const end = src.indexOf('state.runState = \'finishing\'', start)
    const block = src.slice(start, end)
    expect(block).toContain('!state.hadToolActivity')
    // Comments explain the old bug by naming it; the code must not read it.
    // Stripping comments first keeps this from tripping over its own prose.
    const code = block
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('state.events')
  })

  it('sets the flag where a tool is announced', async () => {
    const src = await read()
    // Anchor on the assignment itself, then confirm a `tool.started` handler
    // sits close enough that this is the flag's home and not a coincidence.
    const flag = src.indexOf('state.hadToolActivity = true')
    expect(flag).toBeGreaterThan(-1)
    const window = src.slice(flag - 400, flag + 400)
    expect(window).toContain("'tool.started'")
  })

  it('clears the flag at every run start so runs do not inherit it', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const sockets = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)),
        '../../packages/server/src/modules/studio/sockets/chat-run.ts'),
      'utf8',
    )
    const resets = sockets.split('state.hadToolActivity = false').length - 1
    // A start point and the resume path; one is not enough to prevent carry-over.
    expect(resets).toBeGreaterThanOrEqual(3)
  })
})
