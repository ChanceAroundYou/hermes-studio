<script setup lang="ts">
import { getBaseUrlValue } from '@/api/client'
const logoSrc = `${getBaseUrlValue()}/logo.png`
withDefaults(defineProps<{ size?: number }>(), { size: 48 })
</script>

<template>
  <span class="studio-loading-logo" :style="{ '--studio-loading-size': `${size}px` }" aria-hidden="true">
    <img :src="logoSrc" alt="" draggable="false" />
  </span>
</template>
