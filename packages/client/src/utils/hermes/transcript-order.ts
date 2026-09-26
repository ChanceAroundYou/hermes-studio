/**
 * Splits a transcript so a synthetic entry lands where its own timestamp says it
 * belongs, instead of being appended at the tail.
 *
 * Compression is recorded in the transcript as an event with a real time, so the
 * entry has to sort into the conversation it happened in. Anchor heuristics (for
 * example "after the last /compress command") only covered the explicit command;
 * context auto-compression leaves no command row behind and silently fell through
 * to the bottom of the list.
 */
export function insertByTimestamp<T extends { timestamp?: number | string }>(list: T[], entry: T): T[] {
  const at = Number(entry.timestamp) || 0
  let index = list.length
  for (let i = 0; i < list.length; i++) {
    if ((Number(list[i].timestamp) || 0) > at) {
      index = i
      break
    }
  }
  return [...list.slice(0, index), entry, ...list.slice(index)]
}
