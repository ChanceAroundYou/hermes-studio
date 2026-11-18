import { describe, expect, it } from 'vitest'
import { groupCompletedToolsByRun } from '@/components/hermes/chat/tool-run-grouping'
import type { Message } from '@/stores/hermes/chat'

// Timestamp is deliberately unrelated to the id: a fixture where the timestamp is
// derived from the id cannot tell `chunk:7` (keyed by call) from `chunk:7` (keyed by
// arrival time), so a card id that changes between reloads would pass.
function tool(id: string, runMarker?: string, toolStatus = 'done'): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: 'read',
    toolStatus,
    runMarker,
    timestamp: 1700000000000 + Number(id.replace(/\D/g, '')) * 1000,
  } as Message
}

function text(id: string, role: 'user' | 'assistant' = 'assistant'): Message {
  return { id, role, content: id, timestamp: Number(id.replace(/\D/g, '')) || 1 } as Message
}

function ids(messages: Message[]): string[] {
  return messages.map(m => m.id)
}

describe('tool run grouping', () => {
  it('merges consecutive tool messages into one collapsed card', () => {
    const out = groupCompletedToolsByRun([text('1'), tool('2', 'run-a'), tool('3', 'run-a')])
    expect(out.map(m => m.systemType || m.role)).toEqual(['assistant', 'tool-run'])
    expect(out[1].toolMessages?.map(m => m.id)).toEqual(['2', '3'])
  })

  it('keeps a running tool inside the same card so the spinner does not jump', () => {
    const out = groupCompletedToolsByRun([tool('1', 'run-a', 'running'), tool('2', 'run-a')])
    expect(out).toHaveLength(1)
    expect(out[0].systemType).toBe('tool-run')
  })

  // Option A of the grouping decision: the reader thinks of everything between two
  // assistant turns as one run of calls, and `runMarker` is a server-side per-turn
  // tag, not a visual boundary. Upstream (#2697) grouped strictly by it, so two
  // consecutive calls carrying different markers became two boxes.
  it('merges consecutive calls even when their run markers differ', () => {
    const out = groupCompletedToolsByRun([
      text('1'), tool('2', 'run-a'), tool('3', 'run-b'), tool('4', undefined),
    ])
    expect(out.map(m => m.systemType || m.role)).toEqual(['assistant', 'tool-run'])
    expect(out[1].toolMessages?.map(m => m.id)).toEqual(['2', '3', '4'])
    // The card is keyed by the first call's marker so the id stays stable across a
    // reload; an unmarked run falls back to the first id.
    expect(out[1].runMarker).toBe('run-a')
    expect(out[1].toolRunId).toBe('run-a')
  })

  it('keys an unmarked run by its first call so the card id is stable', () => {
    const out = groupCompletedToolsByRun([tool('7', undefined), tool('8', undefined)])
    expect(out).toHaveLength(1)
    expect(out[0].toolRunId).toBe('chunk:7')
    expect(out[0].toolMessages?.map(m => m.id)).toEqual(['7', '8'])
  })

  it('starts a new card after an assistant message', () => {
    const out = groupCompletedToolsByRun([
      tool('1', 'run-a'), text('2'), tool('3', 'run-b'),
    ])
    expect(out.map(m => m.systemType || m.role)).toEqual(['tool-run', 'assistant', 'tool-run'])
  })

  // Search navigation is why this parameter exists: the message the user jumped
  // to must stay readable, and a collapsed card would hide it.
  it('leaves the searched message out of any card and breaks the chunk around it', () => {
    const out = groupCompletedToolsByRun(
      [tool('1', 'run-a'), tool('2', 'run-a'), tool('3', 'run-a')],
      '2',
    )
    const flat = out.flatMap(m => (m.systemType === 'tool-run' ? m.toolMessages! : [m]))
    expect(ids(flat)).toEqual(['1', '2', '3'])
    // Two cards, not one: the hit is split out of the run.
    expect(out.filter(m => m.systemType === 'tool-run')).toHaveLength(2)
    expect(flat.find(m => m.id === '2')).toBeDefined()
  })

  it('is a no-op when the searched message is not a tool message', () => {
    const messages = [tool('1', 'run-a'), tool('2', 'run-a')]
    expect(ids(groupCompletedToolsByRun(messages, '999'))).toEqual(ids(groupCompletedToolsByRun(messages)))
  })
})
