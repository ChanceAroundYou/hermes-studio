<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NRadioButton, NRadioGroup, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import OAuthLoginShell from './OAuthLoginShell.vue'
import { useOAuthLoginFlow } from '@/composables/useOAuthLoginFlow'
import { pollMiniMaxLogin, startMiniMaxLogin } from '@/api/hermes/minimax-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const region = ref<'global' | 'cn'>('global')
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
  approvedMessage: () => t('models.minimaxApproved'),
  notifySuccess: text => message.success(text),
  notifyError: text => message.error(text),
  onApproved: () => emit('success'),
  onClosed: () => emit('close'),
})

async function startLogin() {
  begin()
  try {
    const result = await startMiniMaxLogin(region.value)
    sessionId.value = result.session_id
    userCode.value = result.user_code
    verificationUrl.value = result.verification_url
    status.value = 'waiting'
    window.open(verificationUrl.value, '_blank')
    startPolling({
      intervalMs: 2_000,
      poll: async id => {
        const result = await pollMiniMaxLogin(id)
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
  window.open(verificationUrl.value, '_blank')
}

async function copyCode() {
  const copied = await copyToClipboard(userCode.value)
  if (copied) message.success(t('common.copied'))
  else message.error(t('chat.copyFailed'))
}

/** Back to the region picker; this provider starts on the user's click. */
function retry() {
  reset()
  userCode.value = ''
  verificationUrl.value = ''
}
</script>

<template>
  <OAuthLoginShell
    v-model:show="show"
    provider="minimax"
    :title="t('models.minimaxLoginTitle')"
    :status="status"
    :error-message="errorMessage"
    :user-code="userCode"
    :mask-closable="status !== 'waiting' && status !== 'loading'"
    :cancel-disabled="status === 'waiting' || status === 'loading'"
    @cancel="close()"
    @retry="retry()"
    @open-link="openLink()"
    @copy-code="copyCode()"
    @close="emit('close')"
  >
    <template #idle>
      <p class="oauth-login__hint">{{ t('models.minimaxRegionHint') }}</p>
      <NRadioGroup v-model:value="region">
        <NRadioButton value="global">{{ t('models.minimaxGlobal') }}</NRadioButton>
        <NRadioButton value="cn">{{ t('models.minimaxChina') }}</NRadioButton>
      </NRadioGroup>
      <NButton type="primary" block @click="startLogin">{{ t('models.minimaxStart') }}</NButton>
    </template>
  </OAuthLoginShell>
</template>
