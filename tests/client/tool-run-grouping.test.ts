import { describe, expect, it } from 'vitest'
import { groupCompletedToolsByRun } from '@/components/hermes/chat/tool-run-grouping'
import type { Message } from '@/stores/hermes/chat'

function tool(id: string, runMarker?: string, toolStatus = 'done'): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: 'read',
    toolStatus,
    runMarker,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
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
