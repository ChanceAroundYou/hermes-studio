<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import OAuthLoginShell from './OAuthLoginShell.vue'
import { useOAuthLoginFlow } from '@/composables/useOAuthLoginFlow'
import { startAnthropicLogin, submitAnthropicLogin } from '@/api/hermes/anthropic-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const authorizationUrl = ref('')
const code = ref('')

const {
  show,
  status,
  sessionId,
  errorMessage,
  begin,
  fail,
  approve,
  expire,
  close,
} = useOAuthLoginFlow({
  approvedMessage: () => t('models.anthropicApproved'),
  notifySuccess: text => message.success(text),
  notifyError: text => message.error(text),
  onApproved: () => emit('success'),
  onClosed: () => emit('close'),
})

async function startLogin() {
  begin()
  try {
    const data = await startAnthropicLogin()
    authorizationUrl.value = data.authorization_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    window.open(authorizationUrl.value, '_blank')
  } catch (error) {
    fail(error)
  }
}

/** This provider has no polling: the user pastes the code back instead. */
async function submitCode() {
  if (!code.value.trim() || !sessionId.value) return
  status.value = 'submitting'
  errorMessage.value = ''
  try {
    const result = await submitAnthropicLogin(sessionId.value, code.value.trim())
    if (result.status === 'approved') approve()
    else if (result.status === 'expired') expire()
    else {
      status.value = 'error'
      errorMessage.value = result.error || 'Unknown error'
    }
  } catch (error) {
    fail(error)
  }
}

function openLink() {
  window.open(authorizationUrl.value, '_blank')
}

async function copyLink() {
  const ok = await copyToClipboard(authorizationUrl.value)
  if (ok) message.success(t('common.copied'))
  else message.error(t('chat.copyFailed'))
}

function retry() {
  authorizationUrl.value = ''
  code.value = ''
  startLogin()
}

startLogin()
</script>

<template>
  <OAuthLoginShell
    v-model:show="show"
    provider="anthropic"
    :title="t('models.anthropicLoginTitle')"
    :status="status"
    :error-message="errorMessage"
    width="min(460px, calc(100vw - 32px))"
    :mask-closable="status !== 'submitting'"
    :cancel-disabled="status === 'submitting'"
    @cancel="close()"
    @retry="retry()"
    @close="emit('close')"
  >
    <template #waiting>
      <p class="oauth-login__hint">{{ t('models.anthropicWaiting') }}</p>
      <NButton type="primary" block @click="openLink">
        {{ t('models.anthropicOpenLink') }}
      </NButton>
      <NButton block @click="copyLink">
        {{ t('models.anthropicCopyLink') }}
      </NButton>
      <NInput
        v-model:value="code"
        type="textarea"
        :placeholder="t('models.anthropicCodePlaceholder')"
        :autosize="{ minRows: 2, maxRows: 4 }"
      />
      <NButton
        type="primary"
        block
        :loading="status === 'submitting'"
        :disabled="!code.trim()"
        @click="submitCode"
      >
        {{ t('models.anthropicSubmitCode') }}
      </NButton>
    </template>
  </OAuthLoginShell>
</template>
