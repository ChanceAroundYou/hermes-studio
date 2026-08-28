<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import thinkingImage from '@/assets/thinking.gif'

const settingsStore = useSettingsStore()
const props = defineProps<{
  reasoning?: string | null
  reasoningId?: string | number | null
  elapsed: string
}>()

const { t } = useI18n()
const expanded = ref(settingsStore.display.show_reasoning !== false)
watch(
  () => settingsStore.display.show_reasoning,
  (v) => { expanded.value = v !== false },
)
const reasoningBody = ref<HTMLElement | null>(null)
let scrollFrame = 0
let visibleReasoningId = props.reasoningId

const reasoningLine = computed(() => {
  return (props.reasoning || '').replace(/\s+/g, ' ').trim()
})

function scrollReasoningToLatest(reset = false) {
  const element = reasoningBody.value
  if (!element) return

  cancelAnimationFrame(scrollFrame)
  if (reset) element.scrollLeft = 0

  const start = element.scrollLeft
  const target = Math.max(0, element.scrollWidth - element.clientWidth)
  const distance = target - start
  if (distance <= 0) {
    element.scrollLeft = target
    return
  }

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    element.scrollLeft = target
    return
  }

  const duration = Math.min(120, Math.max(45, distance * 2.5))
  const startedAt = performance.now()
  const advance = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - (1 - progress) ** 3
    element.scrollLeft = start + distance * eased
    if (progress < 1) scrollFrame = requestAnimationFrame(advance)
  }
  scrollFrame = requestAnimationFrame(advance)
}

watch(
  [reasoningLine, () => props.reasoningId],
  async () => {
    const reset = visibleReasoningId !== props.reasoningId
    visibleReasoningId = props.reasoningId
    await nextTick()
    scrollReasoningToLatest(reset)
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(() => cancelAnimationFrame(scrollFrame))
</script>

<template>
  <div class="live-reasoning-status">
    <div class="thinking-status">
      <img
        :src="thinkingImage"
        alt=""
        aria-hidden="true"
        class="thinking-avatar"
      >
      <div class="thinking-status-copy">
        <span class="thinking-status-label">{{ t('chat.thinkingInProgress') }}</span>
        <span class="thinking-status-time">{{ elapsed }}</span>
      </div>
      <button
        v-if="reasoningLine"
        type="button"
        class="live-reasoning-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="thinking-chevron"
          :class="{ rotated: expanded }"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>{{ expanded ? t('common.collapse') : t('common.expand') }}</span>
      </button>
    </div>
    <div
      v-if="expanded && reasoningLine"
      class="live-reasoning-detail"
      :data-reasoning-id="reasoningId"
    >
      <div class="live-reasoning-label">
        <span aria-hidden="true">💭</span>
        <span>{{ t('chat.thinkingLabel') }}</span>
      </div>
      <div ref="reasoningBody" class="live-reasoning-body">{{ reasoningLine }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.live-reasoning-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  flex: 0 0 auto;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  height: auto;
  min-height: 40px;
  max-height: none;
  min-width: 0;
  overflow: hidden;
}

.thinking-status {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  height: 40px;
  min-height: 40px;
  max-height: 40px;
  overflow: hidden;
}

.thinking-avatar {
  width: 40px;
  height: 40px;
  border-radius: $radius-md;
  object-fit: cover;
  flex-shrink: 0;

  .dark & {
    filter: brightness(1.18) contrast(1.08) saturate(1.08);
  }
}

.thinking-status-copy {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  column-gap: 8px;
  row-gap: 2px;
  min-width: 0;
  height: 20px;
  min-height: 20px;
  max-height: 20px;
  overflow: hidden;
}

.thinking-status-label {
  display: inline-flex;
  align-items: center;
  color: transparent;
  background: linear-gradient(105deg, $text-secondary 0%, $text-secondary 39%, #ffffff 48%, #ffffff 52%, $text-secondary 61%, $text-secondary 100%);
  background-size: 300% 100%;
  background-position: 0% 0;
  -webkit-background-clip: text;
  background-clip: text;
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  animation: thinking-label-shimmer 2.2s linear infinite;
  backface-visibility: hidden;
  contain: paint;
  transform: translateZ(0);
  will-change: background-position;

  .dark & {
    background: linear-gradient(105deg, #f0f0f0 0%, #f0f0f0 37%, #2f3540 47%, #2f3540 53%, #f0f0f0 63%, #f0f0f0 100%);
    background-size: 300% 100%;
    background-position: 0% 0;
    -webkit-background-clip: text;
    background-clip: text;
    filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.16));
  }
}

.thinking-status-time {
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
  color: $text-muted;
  font-family: $font-code;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  min-width: 44px;
}

.thinking-chevron {
  transition: transform 0.18s ease;
  flex-shrink: 0;
}

.thinking-chevron.rotated {
  transform: rotate(90deg);
}

.live-reasoning-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: transparent;
  color: $text-muted;
  font-size: 12px;
  cursor: pointer;
  line-height: 1.4;
  transition: background 0.15s ease, color 0.15s ease;
  flex-shrink: 0;

  &:hover {
    background: rgba(0, 0, 0, 0.04);
    color: $text-secondary;
  }

  .dark & {
    border-color: rgba(255, 255, 255, 0.12);

    &:hover {
      background: rgba(255, 255, 255, 0.06);
      color: $text-primary;
    }
  }
}

.live-reasoning-detail {
  display: flex;
  align-items: center;
  flex: 0 0 30px;
  gap: 8px;
  width: 520px;
  max-width: 100%;
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  min-width: 0;
  box-sizing: border-box;
  padding: 5px 10px;
  border-radius: $radius-sm;
  background: rgba(0, 0, 0, 0.025);
  color: $text-secondary;
  contain: layout paint;
  transition: opacity 80ms linear;

  .dark & {
    background: rgba(255, 255, 255, 0.045);
  }
}

.live-reasoning-label {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  color: $text-muted;
  font-size: 11px;
  font-weight: 500;
}

.live-reasoning-body {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: hidden;
  white-space: nowrap;
  text-overflow: clip;
  font-size: 13px;
  line-height: 20px;
  opacity: 0.9;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

@keyframes thinking-label-shimmer {
  0% {
    background-position: 100% 0;
  }

  100% {
    background-position: 0% 0;
  }
}

</style>
