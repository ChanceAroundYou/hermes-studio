<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import PendingInteractionCountdown from '@/components/hermes/chat/PendingInteractionCountdown.vue'
import { useMobileChatInputViewport } from '@/composables/useMobileChatInputViewport'

/**
 * The one implementation of the "the agent is asking you something" card.
 *
 * It used to exist in four places (main chat inline, main chat portal, group
 * chat inline, global notification window) whose markup, styles and keyboard
 * handling had drifted apart. Every entry point now renders this component, so
 * the behaviour below is defined once:
 *
 * - a choice button answers immediately (one click); the notification window
 *   used to require picking a choice and then confirming it
 * - "Dismiss" is always offered; the notification window used to lack it
 * - desktop: Enter answers, Shift+Enter keeps a newline, and in editor mode
 *   plain Enter keeps a newline while Ctrl/Cmd+Enter answers
 * - phone-sized viewports (<=768px): the virtual keyboard's confirm/return key
 *   only inserts a newline, exactly like the chat composer; only the button
 *   answers
 * - the submit button stays disabled while the answer is empty (and in editor
 *   mode it is always available)
 */
const props = withDefaults(defineProps<{
  question: string
  choices?: string[] | null
  responseMode?: string | null
  countdownDeadline?: number | null
  agentName?: string | null
  /** 'inline' card inside the conversation, 'portal' fixed bottom-right, 'notification' bare content for a host notification window. */
  variant?: 'inline' | 'portal' | 'notification'
  allowDismiss?: boolean
  submitting?: boolean
  modelValue?: string
}>(), {
  choices: null,
  responseMode: 'input',
  countdownDeadline: null,
  agentName: null,
  variant: 'inline',
  allowDismiss: true,
  submitting: false,
  modelValue: '',
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'select', choice: string): void
  (event: 'submit', response: string): void
  (event: 'dismiss'): void
}>()

const { t } = useI18n()
const isMobileViewport = useMobileChatInputViewport()

const isEditor = computed(() => props.responseMode === 'editor')
const choiceList = computed(() => props.choices || [])
const showActions = computed(() => choiceList.value.length > 0 || props.allowDismiss)
const submitDisabled = computed(() => props.submitting || (!isEditor.value && !props.modelValue.trim()))

const rootClass = computed(() => {
  const classes = ['pending-interaction-card', `pending-interaction-card--${props.variant}`]
  // Legacy class names stay on the in-conversation variants so existing
  // selectors and e2e locators keep matching.
  if (props.variant !== 'notification') {
    classes.push('approval-float-panel')
    if (props.variant === 'portal') classes.push('approval-float-panel--global')
  }
  return classes
})

function selectChoice(choice: string) {
  if (props.submitting) return
  emit('select', choice)
}

function answer() {
  if (submitDisabled.value) return
  emit('submit', isEditor.value ? props.modelValue : props.modelValue.trim())
}

function dismiss() {
  if (props.submitting) return
  emit('dismiss')
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || props.submitting) return
  // On a phone the confirm/return key must stay a plain line break.
  if (isMobileViewport.value) return
  if (isEditor.value) {
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    answer()
    return
  }
  if (event.shiftKey) return
  event.preventDefault()
  answer()
}
</script>

<template>
  <div :class="rootClass">
    <div v-if="variant !== 'notification'" class="float-panel-header">
      <span class="approval-float-icon" aria-hidden="true">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
      <span>{{ t('chat.clarifyKicker') }}</span>
      <PendingInteractionCountdown v-if="countdownDeadline" :deadline="countdownDeadline" />
    </div>
    <PendingInteractionCountdown
      v-if="variant === 'notification' && countdownDeadline"
      :deadline="countdownDeadline"
    />
    <div class="approval-float-title">
      <span v-if="agentName">@{{ agentName }} · </span>{{ t('chat.clarifyTitle') }}
    </div>
    <div class="approval-float-desc">{{ question }}</div>
    <div v-if="showActions" class="approval-float-actions">
      <NButton
        v-for="choice in choiceList"
        :key="choice"
        size="small"
        type="primary"
        :disabled="submitting"
        @click="selectChoice(choice)"
      >
        {{ choice }}
      </NButton>
      <NButton
        v-if="allowDismiss"
        size="small"
        type="error"
        secondary
        :disabled="submitting"
        @click="dismiss"
      >
        {{ t('chat.clarifyDismiss') }}
      </NButton>
    </div>
    <div class="clarify-float-input-row">
      <NInput
        size="small"
        :value="modelValue"
        :type="isEditor ? 'textarea' : 'text'"
        :placeholder="t('chat.clarifyPlaceholder')"
        @update:value="value => emit('update:modelValue', value)"
        @keydown="handleKeydown"
      />
      <NButton
        size="small"
        type="primary"
        :disabled="submitDisabled"
        :loading="submitting"
        @click="answer"
      >
        {{ t('chat.clarifySubmit') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

// In-conversation variants (the global notification host draws its own surface).
.pending-interaction-card--inline,
.pending-interaction-card--portal {
  pointer-events: auto;
  width: 100%;
  padding: 10px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(14px);

  .dark & {
    background: #262626;
  }
}

.pending-interaction-card--portal {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  width: min(720px, calc(100vw - 32px));
}

.pending-interaction-card--notification {
  display: flex;
  flex-direction: column;
  max-width: 520px;
  max-height: min(420px, calc(100dvh - 190px));
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
}

.float-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: var(--accent-primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.approval-float-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.12);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
}

.approval-float-title {
  padding: 0 4px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: $text-primary;
}

.approval-float-desc {
  padding: 0 4px;
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-secondary;
}

.approval-float-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;
}

.clarify-float-input-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;

  :deep(.n-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  :deep(.n-button) {
    flex: 0 0 auto;
  }
}

@media (max-width: 640px) {
  .pending-interaction-card--inline,
  .pending-interaction-card--portal {
    padding: 7px;
    border-radius: 14px;
  }

  .pending-interaction-card--portal {
    left: 8px;
    right: 8px;
    bottom: max(8px, env(safe-area-inset-bottom));
    width: auto;
  }

  .approval-float-actions {
    // Buttons must size themselves to their label; fixed-width columns drop
    // long clarify choices.
    :deep(.n-button) {
      width: auto;
      max-width: 100%;
    }

    :deep(.n-button__content) {
      white-space: normal;
      text-align: start;
    }
  }

  .clarify-float-input-row {
    flex-direction: column;

    :deep(.n-button) {
      width: 100%;
    }
  }
}
</style>
