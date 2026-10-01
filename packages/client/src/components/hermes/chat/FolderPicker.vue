<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { NButton, NDropdown, NInput, NModal, NSpace, NSpin, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getActiveProfileName, request } from '@/api/client'
import { copyToClipboard } from '@/utils/clipboard'
import { useWorkspacePreferences } from '@/composables/useWorkspacePreferences'
import { workspaceFolderName } from '@/utils/hermes/workspace-path'
import StarIcon from '@/components/common/StarIcon.vue'
import FolderIcon from '@/components/common/FolderIcon.vue'

interface FolderEntry {
  name: string
  path: string
  fullPath: string
  readonly?: boolean
}

interface FolderListResponse {
  base: string
  current: string
  folders: FolderEntry[]
}

/** Flat display node for rendering tree without recursion */
interface FlatNode {
  folder: FolderEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  hasChildren: boolean | null  // null = unknown
}

const props = defineProps<{
  modelValue: string | null
  /** Which profile's default workspace the picker may set. */
  profile?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const loading = ref(false)
const basePath = ref('')
const folders = ref<FolderEntry[]>([])
const expandedPaths = ref<Set<string>>(new Set())
const childrenCache = ref<Map<string, FolderEntry[]>>(new Map())
const loadingPaths = ref<Set<string>>(new Set())
const selectedPath = ref(props.modelValue || '')
const loadFailed = ref(false)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextTarget = ref<FolderEntry | null>(null)
const renameModalVisible = ref(false)
const renameMode = ref<'create' | 'rename'>('create')
const renameInput = ref('')
const actionLoading = ref(false)

/**
 * Favourites and the per-profile default both live on the server, so the row of
 * favourites at the bottom of the list is the same in every browser and device,
 * and the default is scoped to the profile this picker is editing.
 */
const {
  favorites,
  refresh: refreshPreferences,
  isFavorite,
  toggleFavorite,
  setDefaultWorkspace,
  defaultWorkspaceFor,
} = useWorkspacePreferences()

const activeProfile = computed(() => props.profile || getActiveProfileName() || 'default')

/**
 * The shortcuts row under the directory list: this profile's default first, then
 * the account's favourites. A path that is both shows up once carrying both
 * markers, because the two features are independent but the row is one list.
 */
const shortcutEntries = computed(() => {
  const entries: Array<{ path: string; isDefault: boolean; isFavorite: boolean }> = []
  const seen = new Set<string>()
  const defaultPath = profileDefault.value
  if (defaultPath && !seen.has(defaultPath)) {
    seen.add(defaultPath)
    entries.push({ path: defaultPath, isDefault: true, isFavorite: favorites.value.includes(defaultPath) })
  }
  for (const path of favorites.value) {
    if (seen.has(path)) continue
    seen.add(path)
    entries.push({ path, isDefault: false, isFavorite: true })
  }
  return entries
})
const profileDefault = computed(() => defaultWorkspaceFor(activeProfile.value))

/** A minimal FolderEntry so a favourite can drive the same context menu as a tree row. */
function favoriteEntry(path: string): FolderEntry {
  return { name: workspaceFolderName(path), path, fullPath: path }
}

function isProfileDefault(path: string | null | undefined): boolean {
  const target = String(path || '')
  return Boolean(target) && profileDefault.value === target
}

async function applyFavorite(path: string) {
  await toggleFavorite(path)
}

async function applyDefault(path: string) {
  await setDefaultWorkspace(activeProfile.value, path)
}


onMounted(() => {
  void refreshPreferences(activeProfile.value)
})

watch(() => props.modelValue, (v) => { selectedPath.value = v || '' })

function updateSelectedPath(value: string | null) {
  const next = String(value || '').trim()
  selectedPath.value = next
  emit('update:modelValue', next || null)
}

async function loadFolders(subPath = ''): Promise<FolderListResponse | null> {
  try {
    const query = subPath ? `?path=${encodeURIComponent(subPath)}` : ''
    return await request<FolderListResponse>(`/api/studio/workspace/folders${query}`)
  } catch {
    return null
  }
}

function relativeParentPath(path: string) {
  const windowsPath = path.replace(/\//g, '\\')
  const driveRoot = windowsPath.match(/^([a-zA-Z]:)\\?$/)
  if (driveRoot) return `${driveRoot[1].toUpperCase()}\\`
  const driveChild = windowsPath.match(/^([a-zA-Z]:)\\(.+)$/)
  if (driveChild) {
    const trimmed = windowsPath.replace(/\\+$/, '')
    const idx = trimmed.lastIndexOf('\\')
    return idx <= 2 ? `${driveChild[1].toUpperCase()}\\` : trimmed.slice(0, idx)
  }
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

async function refreshFolderList(subPath = '') {
  const res = await loadFolders(subPath)
  if (!res) {
    loadFailed.value = true
    return
  }
  loadFailed.value = false
  if (!subPath) {
    basePath.value = res.base
    folders.value = res.folders
    return
  }
  childrenCache.value.set(subPath, res.folders)
  childrenCache.value = new Map(childrenCache.value)
}

onMounted(async () => {
  loading.value = true
  await refreshFolderList()
  loading.value = false
})

async function toggleExpand(folder: FolderEntry) {
  if (expandedPaths.value.has(folder.path)) {
    expandedPaths.value.delete(folder.path)
    expandedPaths.value = new Set(expandedPaths.value)
    return
  }

  expandedPaths.value.add(folder.path)
  expandedPaths.value = new Set(expandedPaths.value)

  if (!childrenCache.value.has(folder.path)) {
    loadingPaths.value.add(folder.path)
    loadingPaths.value = new Set(loadingPaths.value)
    const res = await loadFolders(folder.path)
    childrenCache.value.set(folder.path, res?.folders || [])
    childrenCache.value = new Map(childrenCache.value)
    loadingPaths.value.delete(folder.path)
    loadingPaths.value = new Set(loadingPaths.value)
  }
}

function selectFolder(folder: FolderEntry) {
  updateSelectedPath(folder.fullPath)
}

function selectBase() {
  updateSelectedPath(basePath.value)
}

async function openFolder(folder: FolderEntry | null) {
  if (!folder) {
    selectBase()
    return
  }
  selectFolder(folder)
  if (!expandedPaths.value.has(folder.path)) {
    await toggleExpand(folder)
  }
}

function openContextMenuAt(x: number, y: number, folder: FolderEntry | null) {
  contextTarget.value = folder
  contextMenuX.value = x
  contextMenuY.value = y
  contextMenuVisible.value = false
  void nextTick(() => {
    contextMenuVisible.value = true
  })
}

function showContextMenu(event: MouseEvent, folder: FolderEntry | null) {
  event.preventDefault()
  event.stopPropagation()
  openContextMenuAt(event.clientX, event.clientY, folder)
}

/**
 * Touch devices (iOS Safari in particular) do not synthesise `contextmenu` for
 * a long press on a plain element, so a right-click-only menu is unreachable on
 * a phone. Fire the same menu from a long press instead.
 */
const LONG_PRESS_MS = 500
let longPressTimer: number | null = null
let longPressConsumed = false

function cancelLongPress() {
  if (longPressTimer != null) {
    window.clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function startLongPress(event: TouchEvent, folder: FolderEntry | null) {
  if (event.touches.length !== 1) return
  const touch = event.touches[0]
  if (!touch) return
  cancelLongPress()
  longPressConsumed = false
  longPressTimer = window.setTimeout(() => {
    longPressTimer = null
    longPressConsumed = true
    // Suppress the click/long-press text selection and the synthetic contextmenu.
    event.preventDefault()
    openContextMenuAt(touch.clientX, touch.clientY, folder)
  }, LONG_PRESS_MS)
}

onUnmounted(cancelLongPress)

/** A long press must not also select the row it happened on. */
function onRowClick(folder: FolderEntry) {
  if (longPressConsumed) {
    longPressConsumed = false
    return
  }
  selectFolder(folder)
}

const contextOptions = computed(() => {
  const options: any[] = [
    { label: t('files.open'), key: 'open' },
    { type: 'divider', key: 'd1' },
    { label: t('files.copyPath'), key: 'copyPath' },
    { label: t('files.newFolder'), key: 'newFolder' },
  ]
  if (contextTarget.value) {
    // Favourite (shared list) and default (this profile) are separate features
    // and are toggled separately.
    options.push({
      label: isFavorite(contextTarget.value.fullPath) ? t('chat.workspaceUnfavorite') : t('chat.workspaceFavorite'),
      key: 'favorite',
    })
    options.push({
      label: isProfileDefault(contextTarget.value.fullPath) ? t('chat.workspaceUnpin') : t('chat.workspacePin'),
      key: 'default',
    })
    options.push({ type: 'divider', key: 'd0' })
    if (!contextTarget.value.readonly) {
      options.push({ label: t('files.rename'), key: 'rename' })
      options.push({ type: 'divider', key: 'd2' })
      options.push({ label: t('files.delete'), key: 'delete' })
    }
  }
  return options
})

function handleContextOutside() {
  contextMenuVisible.value = false
}

function openRenameModal(mode: 'create' | 'rename') {
  renameMode.value = mode
  renameInput.value = mode === 'rename' ? contextTarget.value?.name || '' : ''
  renameModalVisible.value = true
}

async function handleContextSelect(key: string) {
  contextMenuVisible.value = false
  const folder = contextTarget.value
  switch (key) {
    case 'open':
      await openFolder(folder)
      break
    case 'copyPath': {
      const path = folder?.fullPath || basePath.value
      const ok = await copyToClipboard(path)
      message[ok ? 'success' : 'error'](ok ? t('files.pathCopied') : `${t('files.pathCopied')} ✗`)
      break
    }
    case 'favorite': {
      const path = folder?.fullPath
      if (!path) return
      const nowFavorite = !isFavorite(path)
      await applyFavorite(path)
      message.success(nowFavorite ? t('chat.workspaceFavorited') : t('chat.workspaceUnfavorited'))
      break
    }
    case 'default': {
      const path = folder?.fullPath
      if (!path) return
      const wasDefault = isProfileDefault(path)
      await applyDefault(path)
      message.success(wasDefault ? t('chat.workspaceDefaultCleared') : t('chat.workspaceDefaultSet'))
      break
    }
    case 'newFolder':
      openRenameModal('create')
      break
    case 'rename':
      if (folder) openRenameModal('rename')
      break
    case 'delete':
      if (!folder) return
      dialog.warning({
        title: t('files.delete'),
        content: t('files.confirmDeleteDir', { name: folder.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            await request('/api/studio/workspace/folders', {
              method: 'DELETE',
              body: JSON.stringify({ path: folder.path }),
            })
            if (selectedPath.value === folder.fullPath || selectedPath.value.startsWith(`${folder.fullPath}/`)) {
              updateSelectedPath(null)
            }
            expandedPaths.value.delete(folder.path)
            expandedPaths.value = new Set(expandedPaths.value)
            childrenCache.value.delete(folder.path)
            childrenCache.value = new Map(childrenCache.value)
            await refreshFolderList(relativeParentPath(folder.path))
            message.success(t('files.deleted'))
          } catch {
            message.error(t('files.deleteFailed'))
          }
        },
      })
      break
  }
}

async function submitRenameModal() {
  const name = renameInput.value.trim()
  if (!name) return
  actionLoading.value = true
  try {
    if (renameMode.value === 'create') {
      const parentPath = contextTarget.value?.path || ''
      await request('/api/studio/workspace/folders', {
        method: 'POST',
        body: JSON.stringify({ parentPath, name }),
      })
      if (parentPath) {
        expandedPaths.value.add(parentPath)
        expandedPaths.value = new Set(expandedPaths.value)
      }
      await refreshFolderList(parentPath)
      message.success(t('files.created'))
    } else if (contextTarget.value) {
      const oldFolder = contextTarget.value
      await request('/api/studio/workspace/folders/rename', {
        method: 'POST',
        body: JSON.stringify({ path: oldFolder.path, name }),
      })
      const parentPath = relativeParentPath(oldFolder.path)
      await refreshFolderList(parentPath)
      if (selectedPath.value === oldFolder.fullPath || selectedPath.value.startsWith(`${oldFolder.fullPath}/`)) {
        updateSelectedPath(null)
      }
      message.success(t('files.renamed'))
    }
    renameModalVisible.value = false
  } catch {
    message.error(renameMode.value === 'rename' ? t('files.renameFailed') : t('files.createFailed'))
  } finally {
    actionLoading.value = false
  }
}

/** Build a flat list by DFS traversal of expanded nodes */
const flatNodes = computed<FlatNode[]>(() => {
  const result: FlatNode[] = []

  function traverse(entries: FolderEntry[], depth: number) {
    for (const folder of entries) {
      const isExpanded = expandedPaths.value.has(folder.path)
      const isLoading = loadingPaths.value.has(folder.path)
      const children = childrenCache.value.get(folder.path)
      result.push({
        folder,
        depth,
        isExpanded,
        isLoading,
        hasChildren: children ? children.length > 0 : null,
      })
      if (isExpanded && children && children.length > 0) {
        traverse(children, depth + 1)
      }
    }
  }

  traverse(folders.value, 0)
  return result
})
</script>

<template>
  <div class="folder-picker">
    <div class="folder-path-bar">
      <NInput
        :value="selectedPath"
        :placeholder="t('chat.workspacePlaceholder')"
        :input-props="{ 'aria-label': t('chat.workspacePlaceholder') }"
        clearable
        class="folder-path-input"
        @update:value="updateSelectedPath"
      >
        <template #prefix><FolderIcon class="folder-path-icon" /></template>
      </NInput>
    </div>
    <div v-if="loading" class="folder-picker-loading">
      <NSpin size="small" />
      <span>{{ t('common.loading') }}</span>
    </div>
    <div v-else class="folder-tree">
      <button
        v-if="basePath"
        class="folder-item root"
        type="button"
        :class="{ selected: selectedPath === basePath }"
        :aria-pressed="selectedPath === basePath"
        :title="basePath"
        @click="selectBase"
        @contextmenu="showContextMenu($event, null)"
      >
        <FolderIcon class="folder-icon" open />
        <span class="folder-name">{{ basePath }}</span>
        <svg v-if="selectedPath === basePath" class="folder-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m5 12 4 4L19 6" />
        </svg>
      </button>

      <template v-for="node in flatNodes" :key="node.folder.path">
        <div
          class="folder-item"
          :class="{ selected: selectedPath === node.folder.fullPath }"
          :style="{ paddingInlineStart: `${4 + node.depth * 20}px` }"
          @contextmenu="showContextMenu($event, node.folder)"
          @touchstart="startLongPress($event, node.folder)"
          @touchend="cancelLongPress"
          @touchmove="cancelLongPress"
          @touchcancel="cancelLongPress"
        >
          <button
            class="folder-expand"
            type="button"
            :aria-label="`${t(node.isExpanded ? 'common.collapse' : 'common.expand')}: ${node.folder.name}`"
            :aria-expanded="node.isExpanded"
            :aria-busy="node.isLoading"
            @click.stop="toggleExpand(node.folder)"
          >
            <NSpin v-if="node.isLoading" :size="14" />
            <svg v-else class="folder-chevron" :class="{ expanded: node.isExpanded }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9 5 7 7-7 7" />
            </svg>
          </button>
          <button
            class="folder-select"
            type="button"
            :aria-pressed="selectedPath === node.folder.fullPath"
            :title="node.folder.fullPath"
            @click="onRowClick(node.folder)"
          >
            <FolderIcon class="folder-icon" :open="node.isExpanded" />
            <span class="folder-name">{{ node.folder.name }}</span>
            <svg v-if="selectedPath === node.folder.fullPath" class="folder-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </button>
        </div>
        <div
          v-if="node.isExpanded && !node.isLoading && node.hasChildren === false"
          class="folder-item empty"
          :style="{ paddingInlineStart: `${58 + node.depth * 20}px` }"
        >
          <span class="folder-empty-text">{{ t('chat.folderPickerEmpty') }}</span>
        </div>
      </template>

      <div v-if="folders.length === 0 || loadFailed" class="folder-empty">
        <FolderIcon open />
        <span>{{ t('chat.folderPickerNoFolders') }}</span>
      </div>
    </div>

    <!--
      Display-only row under the directory tree: this profile's default first,
      then the account's favourites. Changing either is done from the context
      menu (right click, or long press on touch) -- there is deliberately no
      button here, so the tree keeps a single gesture vocabulary.
    -->
    <div v-if="shortcutEntries.length > 0" class="folder-shortcuts">
      <div class="folder-shortcuts-row">
        <button
            v-for="entry in shortcutEntries"
            :key="`shortcut-${entry.path}`"
            class="folder-shortcut-chip"
            :class="{ selected: selectedPath === entry.path }"
            type="button"
            :title="entry.path"
            @click="updateSelectedPath(entry.path)"
            @contextmenu="showContextMenu($event, favoriteEntry(entry.path))"
            @touchstart="startLongPress($event, favoriteEntry(entry.path))"
            @touchend="cancelLongPress"
            @touchmove="cancelLongPress"
            @touchcancel="cancelLongPress"
          >
            <span v-if="entry.isDefault" class="folder-shortcut-default" :title="t('chat.defaultWorkspace')">●</span>
            <span v-if="entry.isFavorite" class="folder-shortcut-star" :title="t('chat.workspaceFavorites')">★</span>
            <span class="folder-shortcut-name">{{ workspaceFolderName(entry.path) }}</span>
          </button>
      </div>
    </div>

    <!-- Selected path display -->
    <div v-if="selectedPath" class="folder-selected">
      <span class="folder-selected-label">{{ t('chat.folderPickerSelected') }}</span>
      <span class="folder-selected-path" :title="selectedPath">{{ selectedPath }}</span>
<span class="folder-selected-marks" aria-hidden="false">
        <span v-if="isProfileDefault(selectedPath)" class="folder-shortcut-default">●</span>
        <button
          v-if="isFavorite(selectedPath)"
          class="folder-selected-favorite"
          type="button"
          :title="t('chat.workspaceUnfavorite')"
          :aria-label="t('chat.workspaceUnfavorite')"
          @click.stop="toggleFavorite(selectedPath)"
        >
          <StarIcon :filled="true" />
        </button>
      </span>    </div>

    <NDropdown
      :show="contextMenuVisible"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextOptions"
      placement="bottom-start"
      trigger="manual"
      @select="handleContextSelect"
      @clickoutside="handleContextOutside"
    />

    <NModal
      v-model:show="renameModalVisible"
      preset="dialog"
      :title="renameMode === 'rename' ? t('files.rename') : t('files.newFolder')"
      style="width: 400px;"
    >
      <NInput
        v-model:value="renameInput"
        :placeholder="renameMode === 'rename' ? t('files.renameTo') : t('files.newFolderName')"
      />
      <template #action>
        <NSpace justify="end">
          <NButton size="small" @click="renameModalVisible = false">
            {{ t('common.cancel') }}
          </NButton>
          <NButton size="small" type="primary" :loading="actionLoading" :disabled="!renameInput.trim()" @click="submitRenameModal">
            {{ t('common.confirm') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.folder-picker {
  max-height: 360px;
  min-width: 0;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.folder-path-bar {
  padding: 10px;
  border-bottom: 1px solid $border-light;
  flex-shrink: 0;
}

.folder-path-input {
  font-family: $font-code;
  font-size: 12px;

  :deep(.n-input__prefix) {
    margin-inline-end: 8px;
  }
}

.folder-path-icon {
  color: $text-muted;
}

.folder-tree {
  max-height: 260px;
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  font-size: 13px;
}

.folder-picker-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 16px;
  color: $text-muted;
  font-size: 12px;
}

.folder-item {
  display: flex;
  align-items: center;
  min-height: 36px;
  min-width: 0;
  border-radius: $radius-sm;
  color: $text-secondary;
  transition: background $transition-fast, color $transition-fast;

  &:hover {
    background: $bg-card-hover;
    color: $text-primary;
  }

  &.selected {
    background: rgba(var(--accent-primary-rgb), 0.08);
    color: $accent-primary;
    box-shadow: inset 0 0 0 1px rgba(var(--accent-primary-rgb), 0.12);
  }

  &.root {
    width: 100%;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    background: $bg-secondary;
    font: inherit;
    text-align: start;
    cursor: pointer;
    margin-bottom: 6px;

    &.selected {
      background: rgba(var(--accent-primary-rgb), 0.08);
    }

    .folder-name {
      font-family: $font-code;
      font-size: 12px;
    }
  }

  &.empty {
    min-height: 28px;
    color: $text-muted;
    background: transparent;
  }
}

.folder-select,
.folder-expand,
.folder-selected-favorite {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: $radius-sm;
}

.folder-select:focus-visible,
.folder-expand:focus-visible,
.folder-selected-favorite:focus-visible,
.folder-item.root:focus-visible {
  outline: 2px solid $accent-primary;
  outline-offset: -2px;
}

.folder-select {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 6px 10px 6px 4px;
  font: inherit;
  text-align: start;
}

.folder-expand {
  width: 26px;
  height: 30px;
  flex: 0 0 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: $text-muted;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.folder-chevron {
  transition: transform $transition-fast;

  &.expanded {
    transform: rotate(90deg);
  }
}

.folder-icon,
.folder-check {
  flex-shrink: 0;
}

.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-empty-text {
  font-size: 12px;
}

.folder-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 24px 16px;
  color: $text-muted;
}

.folder-selected {
  padding: 8px 12px;
  border-top: 1px solid $border-light;
  background: $bg-secondary;
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
  flex-shrink: 0;
}

.folder-selected-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.folder-selected-label {
  font-size: 11px;
  line-height: 16px;
  color: $text-muted;
}

.folder-selected-path {
  font: 12px/18px $font-code;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-selected-favorite {
  width: 30px;
  height: 30px;
  padding: 0;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  transition: background $transition-fast, color $transition-fast;

  &:hover:not(:disabled) {
    color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  &.is-pinned {
    color: $accent-primary;
  }
}

@media (prefers-reduced-motion: reduce) {
  .folder-chevron {
    transition: none;
  }
}

.folder-shortcuts {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.folder-shortcuts-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  max-height: 76px;
  overflow-y: auto;
}

.folder-shortcut-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 170px;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  user-select: none;
  -webkit-touch-callout: none;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  &.selected {
    border-color: rgba(var(--accent-primary-rgb), 0.6);
    color: $text-primary;
  }
}

.folder-shortcut-default {
  color: #f5a623;
  font-size: 10px;
  line-height: 1;
}

.folder-shortcut-star {
  color: #f5a623;
  font-size: 11px;
  line-height: 1;
}

.folder-shortcut-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-selected-marks {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.folder-row-default {
  margin-inline-start: auto;
  padding-inline-start: 6px;
  font-size: 10px;
  line-height: 1;
  color: #f5a623;
  flex-shrink: 0;
}

.folder-row-star {
  margin-inline-start: auto;
  padding-inline-start: 6px;
  font-size: 12px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.5);
  background: transparent;
  border: none;
  cursor: pointer;
  flex-shrink: 0;

  &.is-pinned {
    color: #f5a623;
  }

  &:hover {
    color: #f5a623;
  }
}

</style>
