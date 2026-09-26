<script setup lang="ts">
import { ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import OAuthLoginShell from './OAuthLoginShell.vue'
import { useOAuthLoginFlow } from '@/composables/useOAuthLoginFlow'
import { pollXaiLogin, startXaiLogin } from '@/api/hermes/xai-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const authorizationUrl = ref('')

const {
  show,
  status,
  sessionId,
  errorMessage,
  begin,
  fail,
  reset,
  close,
  startPolling,
} = useOAuthLoginFlow({
  approvedMessage: () => t('models.xaiApproved'),
  notifySuccess: text => message.success(text),
  notifyError: text => message.error(text),
  onApproved: () => emit('success'),
  onClosed: () => emit('close'),
})

async function startLogin() {
  begin()
  try {
    const data = await startXaiLogin()
    authorizationUrl.value = data.authorization_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    window.open(authorizationUrl.value, '_blank')
    startPolling({
      intervalMs: 2_000,
      poll: async id => {
        const result = await pollXaiLogin(id)
        if (result.status === 'pending') return { kind: 'pending' }
        if (result.status === 'approved') return { kind: 'approved' }
        if (result.status === 'expired') return { kind: 'expired' }
        return { kind: 'failed', message: result.error || 'Unknown error' }
      },
    })
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
  reset()
  authorizationUrl.value = ''
  startLogin()
}

startLogin()
</script>

<template>
  <OAuthLoginShell
    v-model:show="show"
    provider="xai"
    :title="t('models.xaiLoginTitle')"
    :status="status"
    :error-message="errorMessage"
    state-min-height="120px"
    :mask-closable="status !== 'waiting'"
    :cancel-disabled="status === 'waiting'"
    @cancel="close()"
    @retry="retry()"
    @open-link="openLink()"
    @close="emit('close')"
  >
    <template #waiting>
      <p class="oauth-login__hint">{{ t('models.xaiWaiting') }}</p>
      <NButton type="primary" block @click="openLink">{{ t('models.xaiOpenLink') }}</NButton>
      <NButton block @click="copyLink">{{ t('models.xaiCopyLink') }}</NButton>
    </template>
  </OAuthLoginShell>
</template>
