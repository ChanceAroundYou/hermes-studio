import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { isMobileChatInputViewport } from '@/utils/chat-input-height'

/**
 * Reactive "phone-sized chat viewport" flag (width <= 768), kept in sync with
 * window resizes.
 *
 * Mobile composers use it so the virtual keyboard's confirm / return key only
 * inserts a newline: on a phone every confirm key must stay a plain line break
 * and the only way to submit is the send button, while desktop keeps
 * Enter-to-send.
 */
export function useMobileChatInputViewport(): Ref<boolean> {
  const isMobileViewport = ref(
    typeof window !== 'undefined' ? isMobileChatInputViewport(window.innerWidth) : false,
  )

  function syncViewport() {
    if (typeof window === 'undefined') return
    isMobileViewport.value = isMobileChatInputViewport(window.innerWidth)
  }

  onMounted(() => window.addEventListener('resize', syncViewport))
  onUnmounted(() => window.removeEventListener('resize', syncViewport))

  return isMobileViewport
}
