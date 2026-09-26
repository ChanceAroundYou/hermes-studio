<script setup lang="ts">
import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import OAuthLoginShell from './OAuthLoginShell.vue'
import { oauthLoginErrorText, useOAuthLoginFlow } from '@/composables/useOAuthLoginFlow'
import { pollCopilotLogin, startCopilotLogin } from '@/api/hermes/copilot-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const userCode = ref('')
const verificationUrl = ref('')

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
  approvedMessage: () => t('models.copilotApproved'),
  notifySuccess: text => message.success(text),
  notifyError: text => message.error(text),
  onApproved: () => emit('success'),
  onClosed: () => emit('close'),
})

async function startLogin() {
  begin()
  try {
    const data = await startCopilotLogin()
    userCode.value = data.user_code
    verificationUrl.value = data.verification_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    startPolling({
      intervalMs: 3_000,
      poll: async id => {
        const result = await pollCopilotLogin(id)
        if (result.status === 'pending') return { kind: 'pending' }
        if (result.status === 'approved') return { kind: 'approved' }
        if (result.status === 'expired') return { kind: 'expired' }
        if (result.status === 'denied') return { kind: 'failed', message: t('models.copilotDenied') }
        return { kind: 'failed', message: result.error || 'Unknown error' }
      },
    })
  } catch (error) {
    fail(oauthLoginErrorText(error))
  }
}

async function copyCode() {
  const ok = await copyToClipboard(userCode.value)
  if (ok) message.success(t('models.copilotCopyCode'))
  else message.error(`${t('models.copilotCopyCode')} ✗`)
}

function openLink() {
  window.open(verificationUrl.value, '_blank')
}

function retry() {
  reset()
  userCode.value = ''
  verificationUrl.value = ''
  startLogin()
}

startLogin()
</script>

<template>
  <OAuthLoginShell
    v-model:show="show"
    provider="copilot"
    :title="t('models.copilotLoginTitle')"
    :status="status"
    :error-message="errorMessage"
    :user-code="userCode"
    state-min-height="120px"
    :mask-closable="status !== 'waiting'"
    :cancel-disabled="status === 'waiting'"
    @cancel="close()"
    @retry="retry()"
    @open-link="openLink()"
    @copy-code="copyCode()"
    @close="emit('close')"
  />
</template>
