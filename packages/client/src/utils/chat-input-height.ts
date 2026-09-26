import { MOBILE_LAYOUT_BREAKPOINT } from './viewport'

/** The composer shares the client-wide phone breakpoint. */
export const CHAT_INPUT_MOBILE_BREAKPOINT = MOBILE_LAYOUT_BREAKPOINT
export const MIN_CHAT_INPUT_HEIGHT = 48
export const MAX_CHAT_INPUT_HEIGHT = 400

export function clampChatInputHeight(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return null

  return Math.min(MAX_CHAT_INPUT_HEIGHT, Math.max(MIN_CHAT_INPUT_HEIGHT, Math.round(numericValue)))
}

export function isMobileChatInputViewport(width: number): boolean {
  return width <= CHAT_INPUT_MOBILE_BREAKPOINT
}