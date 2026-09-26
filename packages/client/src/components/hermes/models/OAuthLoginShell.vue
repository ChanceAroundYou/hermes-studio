<script setup lang="ts">
import { NButton, NModal, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { OAuthLoginStatus } from '@/composables/useOAuthLoginFlow'

/**
 * The card every provider OAuth login modal renders.
 *
 * The six modals were byte-identical apart from their i18n prefix, their width
 * and their waiting body, so the shell owns the states (idle, loading, waiting,
 * approved, expired, error) and a provider only supplies what is actually its
 * own through the `idle` and `waiting` slots.
 *
 * Styles are intentionally not scoped: the `waiting` slot content is authored by
 * the provider, and scoped rules would not reach it.
 */
const props = withDefaults(defineProps<{
  /** The i18n prefix the modals share under `models.` (e.g. 'codex'). */
  provider: string
  title: string
  status: OAuthLoginStatus
  errorMessage?: string
  /** The device/user code, shown by the shared waiting body. */
  userCode?: string
  width?: string
  stateMinHeight?: string
  cancelDisabled?: boolean
  maskClosable?: boolean
}>(), {
  errorMessage: '',
  userCode: '',
  width: 'min(440px, calc(100vw - 32px))',
  stateMinHeight: '140px',
  cancelDisabled: false,
  maskClosable: true,
})

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  close: []
  cancel: []
  retry: []
  openLink: []
  copyCode: []
}>()

const { t } = useI18n()
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="title"
    :style="{ width }"
    :mask-closable="maskClosable"
    @after-leave="emit('close')"
  >
    <div class="oauth-login" :style="{ '--oauth-login-state-min-height': stateMinHeight }">
      <div v-if="status === 'idle'" class="oauth-login__state">
        <slot name="idle">
          <NSpin size="small" />
        </slot>
      </div>

      <div v-else-if="status === 'loading'" class="oauth-login__state">
        <NSpin size="small" />
      </div>

      <div v-else-if="status === 'waiting' || status === 'submitting'" class="oauth-login__state">
        <slot name="waiting">
          <p class="oauth-login__hint">{{ t(`models.${props.provider}Waiting`) }}</p>
          <button type="button" class="oauth-login__code" @click="emit('copyCode')">
            <span class="oauth-login__code-text">{{ userCode }}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          <NButton type="primary" block @click="emit('openLink')">
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </template>
            {{ t(`models.${props.provider}OpenLink`) }}
          </NButton>
        </slot>
      </div>

      <div v-else-if="status === 'approved'" class="oauth-login__state oauth-login__state--success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t(`models.${props.provider}Approved`) }}</p>
      </div>

      <div v-else-if="status === 'expired'" class="oauth-login__state">
        <p class="oauth-login__error">{{ t(`models.${props.provider}Expired`) }}</p>
        <NButton size="small" @click="emit('retry')">{{ t('common.retry') }}</NButton>
      </div>

      <div v-else-if="status === 'error'" class="oauth-login__state">
        <p class="oauth-login__error">{{ errorMessage }}</p>
        <NButton size="small" @click="emit('retry')">{{ t('common.retry') }}</NButton>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="cancelDisabled" @click="emit('cancel')">{{ t('common.cancel') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style lang="scss">
.oauth-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  width: 100%;
}

.oauth-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  min-height: var(--oauth-login-state-min-height, 140px);
  justify-content: center;
  width: 100%;
}

.oauth-login__hint {
  margin: 0;
  font-size: 14px;
  color: var(--n-text-color, inherit);
  text-align: center;
  line-height: 1.6;
}

.oauth-login__code {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border: 1px solid var(--n-border-color, #e0e0e6);
  border-radius: 8px;
  background: var(--n-color, #fafafa);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.2s;

  &:hover {
    border-color: var(--n-primary-color, #18a058);
  }
}

.oauth-login__code-text {
  font-size: 28px;
  font-weight: 700;
  font-family: monospace;
  letter-spacing: 4px;
  color: var(--n-text-color, inherit);
}

.oauth-login__state--success {
  color: #18a058;

  svg {
    stroke: #18a058;
  }
}

.oauth-login__error {
  margin: 0;
  color: #d03050;
  text-align: center;
  line-height: 1.6;
  word-break: break-word;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
