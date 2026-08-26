<script setup lang="ts">
import { ref, watch, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import thinkingImage from '@/assets/thinking.gif'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('./MarkdownRenderer.vue')).default)

const settingsStore = useSettingsStore()
const props = defineProps<{
  reasoning?: string | null
  reasoningId?: string | number | null
  elapsed: string
}>()

const { t } = useI18n()

// Default follow show_reasoning; user manual click is stored in expanded and
// only resets when the setting changes. Clicking the toggle button always
// flips the local state.
const expanded = ref(!!settingsStore.display.show_reasoning)
watch(
  () => settingsStore.display.show_reasoning,
  (v) => { expanded.value = !!v },
)
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
        v-if="reasoning"
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
      v-if="reasoning && expanded"
      :key="reasoningId ?? reasoning"
      class="live-reasoning-detail"
      :data-reasoning-id="reasoningId"
    >
      <div class="live-reasoning-label">
        <span aria-hidden="true">💭</span>
        <span>{{ t('chat.thinkingLabel') }}</span>
      </div>
      <div class="live-reasoning-body">
        <MarkdownRenderer :content="reasoning" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.live-reasoning-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.thinking-status {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 40px;
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
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  min-width: 0;
  min-height: 20px;
  flex: 1;
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
  margin-inline-start: auto;
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
  width: 520px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 10px;
  border-radius: $radius-sm;
  background: rgba(0, 0, 0, 0.025);
  color: $text-secondary;

  .dark & {
    background: rgba(255, 255, 255, 0.045);
  }
}

.live-reasoning-label {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  color: $text-muted;
  font-size: 11px;
  font-weight: 500;
}

.live-reasoning-body {
  max-height: 220px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.55;
  opacity: 0.9;

  :deep(.markdown-body > :first-child) {
    margin-top: 0;
  }

  :deep(.markdown-body > :last-child) {
    margin-bottom: 0;
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
