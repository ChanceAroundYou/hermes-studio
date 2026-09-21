<script setup lang="ts">
import { computed, ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NText, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const MAX_LENGTH = 32

const props = defineProps<{ profileName: string }>()
const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
// Seed with the existing custom name (empty when none configured).
const customName = ref(
  profilesStore.profiles.find(profile => profile.name === props.profileName)?.displayName ?? '',
)

const resolvedName = computed(() => customName.value.trim() || props.profileName)
const tooLong = computed(() => Array.from(customName.value.trim()).length > MAX_LENGTH)

function handleInput(value: string) {
  // Strip control characters only; the server caps the length too.
  customName.value = value.replace(/[\u0000-\u001f\u007f]/g, '')
}

async function handleSave() {
  if (tooLong.value) {
    message.warning(t('profiles.displayName.tooLong', { max: MAX_LENGTH }))
    return
  }
  loading.value = true
  try {
    const trimmed = customName.value.trim()
    await profilesStore.updateDisplayName(props.profileName, trimmed || null)
    message.success(t('profiles.displayName.saveSuccess'))
    emit('saved')
  } catch (err: any) {
    message.error(err?.message || t('profiles.displayName.saveFailed'))
  } finally {
    loading.value = false
  }
}

function handleReset() {
  customName.value = ''
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('profiles.displayName.title')"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('profiles.displayName.label')">
        <NInput
          v-model:value="customName"
          data-testid="profile-display-name-input"
          :placeholder="t('profiles.displayName.placeholder')"
          :maxlength="MAX_LENGTH"
          clearable
          @input="handleInput"
        />
      </NFormItem>
      <NText depth="3" style="font-size: 12px; display: block; margin-bottom: 6px;">
        {{ t('profiles.displayName.hint') }}
      </NText>
      <NText depth="2" style="font-size: 12px; display: block;">
        <strong data-testid="profile-display-name-preview">{{ resolvedName }}</strong>
      </NText>
      <NText v-if="tooLong" type="warning" style="font-size: 12px; display: block; margin-top: 6px;">
        {{ t('profiles.displayName.tooLong', { max: MAX_LENGTH }) }}
      </NText>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton v-if="customName" quaternary @click="handleReset">
          {{ t('profiles.displayName.reset') }}
        </NButton>
        <div class="modal-footer-right">
          <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="loading" @click="handleSave">
            {{ t('common.confirm') }}
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.modal-footer-right {
  display: flex;
  gap: 8px;
  margin-inline-start: auto;
}
</style>
