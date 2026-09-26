<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import PendingInteractionCountdown from '@/components/hermes/chat/PendingInteractionCountdown.vue'
import { useMobileChatInputViewport } from '@/composables/useMobileChatInputViewport'
import { copyToClipboard } from '@/utils/clipboard'
import type { PendingCardAction } from '@/utils/hermes/pending-card-action'

/**
 * The single implementation of every "the agent needs an answer" panel: tool
 * approvals and clarifications, in the main chat, the group chat, the realtime
 * voice portal and the global notification window.
 *
 * Those used to be five separate renderings that drifted apart: two header
 * class names, the group chat silently dropping the "allow session" choice, a
 * command preview with a copy button in one host and a bare <code> in another,
 * the main chat ignoring Enter, and three copies of the mobile Enter rule.
 *
 * Hosts now only supply data:
 * - `kind: 'approval'` renders the approval action set from the choice codes the
 *   server offered, so every host offers exactly the same choices
 * - `kind: 'clarify'` renders choice buttons plus a free-text row
 * - `kind: 'custom'` renders an explicit `actions` list (agent pairing, workflow)
 *
 * Unified behaviour: an action answers on one click, a clarification always
 * offers Dismiss, the command preview is copyable everywhere, desktop Enter
 * answers (Ctrl/Cmd+Enter in editor mode) while phone-sized viewports keep
 * every confirm/return key as a plain newline so only the button answers.
 */
const props = withDefaults(defineProps<{
  kind?: 'clarify' | 'approval' | 'custom'
  /** 'inline' card inside the conversation, 'portal' fixed bottom-right, 'notification' bare content for a host notification window. */
  variant?: 'inline' | 'portal' | 'notification'
  icon?: 'question' | 'shield' | 'pairing' | 'none' | null
  /** Header text overrides; both default to the kind's i18n label. */
  kicker?: string | null
  title?: string | null
  /** Rendered as "@prefix · title" when a title is present too. */
  titlePrefix?: string | null
  description?: string | null
  question?: string | null
  command?: string | null
  /** Clarify choices (answered on click). */
  choices?: string[] | null
  /** Approval choice codes offered by the server. */
  approvalChoices?: string[] | null
  isMemoryWrite?: boolean
  /** Explicit actions for `kind: 'custom'`. */
  actions?: PendingCardAction[] | null
  allowInput?: boolean | null
  allowDismiss?: boolean | null
  responseMode?: string | null
  modelValue?: string
  countdownDeadline?: number | null
  submitting?: boolean
}>(), {
  kind: 'clarify',
  variant: 'inline',
  icon: null,
  kicker: null,
  title: null,
  titlePrefix: null,
  description: null,
  question: null,
  command: null,
  choices: null,
  approvalChoices: null,
  isMemoryWrite: false,
  actions: null,
  allowInput: null,
  allowDismiss: null,
  responseMode: 'input',
  modelValue: '',
  countdownDeadline: null,
  submitting: false,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'select', key: string): void
  (event: 'submit', response: string): void
  (event: 'dismiss'): void
  (event: 'copy-failed'): void
}>()

const { t } = useI18n()
const isMobileViewport = useMobileChatInputViewport()

const isClarify = computed(() => props.kind === 'clarify')
const showInput = computed(() => props.allowInput ?? isClarify.value)
const showDismiss = computed(() => props.allowDismiss ?? isClarify.value)
const isEditor = computed(() => props.responseMode === 'editor')
const iconName = computed(() => props.icon
  ?? (isClarify.value ? 'question' : props.kind === 'approval' ? 'shield' : 'none'))
const kickerText = computed(() => props.kicker
  ?? (isClarify.value ? t('chat.clarifyKicker') : props.kind === 'approval' ? t('chat.approvalKicker') : ''))
const titleText = computed(() => props.title
  ?? (isClarify.value ? t('chat.clarifyTitle') : props.kind === 'approval' ? t('chat.approvalTitle') : ''))
const bodyText = computed(() => (isClarify.value ? props.question : props.description) || '')

const APPROVAL_ORDER = ['once', 'session', 'always', 'deny'] as const
const approvalLabels = computed<Record<string, string>>(() => ({
  once: props.isMemoryWrite ? t('chat.approvalAgree') : t('chat.approvalAllowOnce'),
  session: t('chat.approvalAllowSession'),
  always: t('chat.approvalAlways'),
  deny: t('chat.approvalDeny'),
}))
const actionList = computed<PendingCardAction[]>(() => {
  if (props.kind === 'approval') {
    const offered = props.approvalChoices || []
    // The server decides which grants exist; render them in a stable order so
    // every host shows the same buttons (the group chat used to drop `session`).
    const codes = props.isMemoryWrite ? ['once', 'deny'] : APPROVAL_ORDER.filter(code => offered.includes(code))
    return codes.map(code => ({
      key: code,
      label: approvalLabels.value[code] || code,
      variant: code === 'once' ? 'primary' as const : code === 'deny' ? 'error' as const : 'default' as const,
    }))
  }
  if (isClarify.value) {
    return (props.choices || []).map(choice => ({ key: choice, label: choice, variant: 'primary' as const }))
  }
  return props.actions || []
})
const showActions = computed(() => actionList.value.length > 0 || showDismiss.value)
const submitDisabled = computed(() => props.submitting || (!isEditor.value && !props.modelValue.trim()))

const copied = ref(false)
const copyFailed = ref(false)
watch(() => props.command, () => {
  copied.value = false
  copyFailed.value = false
})

async function copyCommand() {
  if (!props.command) return
  const done = await copyToClipboard(props.command)
  if (!done) {
    copyFailed.value = true
    emit('copy-failed')
    return
  }
  copyFailed.value = false
  copied.value = true
}

function selectAction(key: string) {
  if (props.submitting) return
  emit('select', key)
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
</script>

<template>
  <div :class="rootClass">
    <div v-if="variant !== 'notification'" class="float-panel-header">
      <span class="approval-float-icon" aria-hidden="true">
        <svg
          v-if="iconName === 'question'"
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
        <svg
          v-else-if="iconName === 'shield'"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <svg
          v-else-if="iconName === 'pairing'"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0M19 8v6M16 11h6" />
        </svg>
      </span>
      <span>{{ kickerText }}</span>
      <PendingInteractionCountdown v-if="countdownDeadline" :deadline="countdownDeadline" />
    </div>
    <PendingInteractionCountdown
      v-else-if="countdownDeadline"
      :deadline="countdownDeadline"
    />
    <div v-if="variant !== 'notification'" class="approval-float-title">
      <span v-if="titlePrefix && titleText">@{{ titlePrefix }} · </span>{{ titleText }}
    </div>
    <div v-if="bodyText" class="approval-float-desc">{{ bodyText }}</div>
    <div v-if="command" class="approval-float-command studio-surface">
      <div class="approval-float-command-header">
        <span class="approval-float-command-label">{{ t('chat.approvalCommand') }}</span>
        <NButton size="tiny" quaternary @click="copyCommand">
          {{ copyFailed ? t('chat.copyFailed') : copied ? t('common.copied') : t('common.copy') }}
        </NButton>
      </div>
      <pre tabindex="0"><code>{{ command }}</code></pre>
    </div>
    <div v-if="showActions" class="approval-float-actions">
      <NButton
        v-for="action in actionList"
        :key="action.key"
        size="small"
        :type="action.variant === 'primary' ? 'primary' : action.variant === 'error' ? 'error' : 'default'"
        :secondary="action.variant !== 'primary'"
        :loading="action.loading ?? submitting"
        :disabled="action.disabled"
        @click="selectAction(action.key)"
      >
        {{ action.label }}
      </NButton>
      <NButton
        v-if="showDismiss"
        size="small"
        type="error"
        secondary
        :disabled="submitting"
        @click="dismiss"
      >
        {{ t('chat.clarifyDismiss') }}
      </NButton>
    </div>
    <div v-if="showInput" class="clarify-float-input-row">
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

.approval-float-command {
  display: block;
  margin: 8px 4px 0;
  border: 1px solid rgba(var(--text-primary-rgb), 0.1);
  border-radius: 10px;
  background: rgba(var(--accent-primary-rgb), 0.055);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.035);
  overflow: hidden;
}

.approval-float-command-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid rgba(var(--text-primary-rgb), 0.08);
}

.approval-float-command-label {
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;
}

.approval-float-command pre {
  max-height: 240px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  overscroll-behavior: contain;
  white-space: pre;
}

.approval-float-command code {
  display: block;
  width: max-content;
  min-width: 100%;
  color: $text-primary;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
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
    // long clarification choices.
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
