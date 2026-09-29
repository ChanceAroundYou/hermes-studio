// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { getBaseUrlValue } from '@/api/client'
const asset = (p: string) => `${getBaseUrlValue()}/coding-agents/${p}`

describe('single chat Agent avatars', () => {
  it('shows Ekko before the session loads while preserving legacy Hermes sessions', () => {
    for (const session of [null, undefined]) {
      expect(chatSessionAgentAvatar(session)).toEqual({
        label: 'Ekko',
        src: asset('ekko-agent.png'),
      })
    }
    expect(chatSessionAgentAvatar({ source: 'cli' })).toEqual({
      label: 'Hermes',
      src: asset('hermes.png'),
    })
  })

  it.each([
    ['Hermes', { agent: 'hermes' }, asset('hermes.png')],
    ['Ekko', { agent: 'ekko-agent' }, asset('ekko-agent.png')],
    ['Ekko', { agent: 'ekko_agent' }, asset('ekko-agent.png')],
    ['Claude', { agent: 'claude' }, asset('claude-code.svg')],
    ['Claude', { codingAgentId: 'claude-code' }, asset('claude-code.svg')],
    ['Codex', { codingAgentId: 'codex' }, asset('codex-openai.png')],
    ['DeepSeek Harness', { codingAgentId: 'dsh' }, asset('deepseek.svg')],
    ['Pi', { codingAgentId: 'pi' }, asset('pi.svg')],
    ['Grok', { codingAgentId: 'grok' }, asset('grok.svg')],
    ['Cursor', { codingAgentId: 'cursor' }, asset('cursor-logo.png')],
    ['OpenCode', { codingAgentId: 'opencode' }, asset('opencode.png')],
  ])('maps session identity to the $label avatar', (label, session, src) => {
    expect(chatSessionAgentAvatar(session)).toEqual({ label, src })
  })

  it('keeps legacy Coding Agent sessions without identity on the Claude avatar', () => {
    expect(chatSessionAgentAvatar({ source: 'coding_agent' })).toEqual({
      label: 'Claude',
      src: asset('claude-code.svg'),
    })
  })
})
