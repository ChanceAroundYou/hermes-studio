import { describe, expect, it } from 'vitest'
import { insertByTimestamp } from '@/utils/hermes/transcript-order'

/**
 * Reproduces the reported bug: an auto-compression that happened at 10:20 was
 * rendered at the very bottom of the transcript, below a message from 10:31,
 * because the synthetic card was appended instead of sorted by its own time.
 */
describe('transcript ordering for synthetic entries', () => {
  const at = (hhmm: string) => ({ timestamp: Date.parse(`2026-09-26T${hhmm}:00`) })

  it('places an entry before the first message that came later', () => {
    const messages = [
      { id: 'u1', ...at('10:12') },
      { id: 'a1', ...at('10:31') },
    ]
    const card = { id: 'compression', ...at('10:20') }

    expect(insertByTimestamp(messages, card).map(entry => entry.id)).toEqual(['u1', 'compression', 'a1'])
  })

  it('appends when nothing came later', () => {
    const messages = [{ id: 'u1', ...at('10:12') }]
    const card = { id: 'compression', ...at('10:20') }

    expect(insertByTimestamp(messages, card).map(entry => entry.id)).toEqual(['u1', 'compression'])
  })

  it('keeps an entry after equal timestamps so an explicit /compress row stays above it', () => {
    const messages = [{ id: 'slash-compress', ...at('10:20') }]
    const card = { id: 'compression', ...at('10:20') }

    expect(insertByTimestamp(messages, card).map(entry => entry.id)).toEqual(['slash-compress', 'compression'])
  })

  it('never mutates the input array', () => {
    const messages = [{ id: 'a', ...at('10:31') }]
    insertByTimestamp(messages, { id: 'compression', ...at('10:20') })

    expect(messages.map(entry => entry.id)).toEqual(['a'])
  })

  it('treats a missing timestamp as the oldest entry instead of dropping it', () => {
    const card = { id: 'compression' }
    expect(insertByTimestamp([{ id: 'a', ...at('10:31') }], card).map(entry => entry.id)).toEqual(['compression', 'a'])
  })
})
