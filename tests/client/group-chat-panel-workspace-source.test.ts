import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GROUP_AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'
import { isGlobalOnlyCodingAgent, isNativeCodingAgent } from '../../packages/client/src/utils/agent-catalog'
import { submittedCodingAgentSelection } from '../../packages/client/src/utils/coding-agent-mode'

/**
 * Upstream 0.8.20 routed borders and radii through design tokens, so the identical rule is
 * now written `border: var(--border-width, 1px) solid #fff` instead of
 * `border: 1px solid #fff`. A guard written against the bare literal stops matching while
 * the rendered border has not changed at all. hasDeclaration reads one property inside one
 * selector block, unwraps `var(<token>, <fallback>)` to its fallback value, and compares
 * against the value the guard is about: deleting the declaration, changing the colour, or
 * changing the fallback all still fail.
 */
function selectorBody(source: string, selector: string): string {
  for (const variant of [selector + ' {', selector + '{']) {
    let at = source.indexOf(variant)
    while (at >= 0) {
      const open = at + variant.length - 1
      let depth = 0
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1
        else if (source[i] === '}') {
          depth -= 1
          if (depth === 0) return source.slice(open, i + 1)
        }
      }
      at = source.indexOf(variant, at + 1)
    }
  }
  return ''
}

function declarationValue(source: string, selector: string, property: string): string | null {
  const body = selectorBody(source, selector)
  if (!body) return null
  const match = new RegExp(String.raw`${property}:([^;]*);`).exec(body)
  if (!match) return null
  return match[1].trim().replace(/var\(--[a-z-]+,\s*([^)]*)\)/g, '$1')
}

function hasDeclaration(source: string, selector: string, property: string, value: string): boolean {
  return declarationValue(source, selector, property) === value
}

describe('GroupChatPanel workspace save handling', () => {
  it('offers Pi, Grok, and OpenCode in ordinary and paired group chat and filters each provider target', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const linkView = readFileSync('packages/client/src/views/hermes/GroupChatLinkView.vue', 'utf8')

    expect(GROUP_AGENT_OPTIONS).toEqual(expect.arrayContaining([
      { label: 'Pi', value: 'pi' },
      { label: 'Grok', value: 'grok' },
      { label: 'OpenCode', value: 'opencode' },
      { label: 'Cursor', value: 'cursor' },
    ]))
    for (const source of [panel, linkView]) {
      expect(source).toContain('const groupAgentTypeDefinitions = GROUP_AGENT_OPTIONS')
      // These used to be per-agent `selectedAgentType.value === 'x'` branches inside each
      // surface, which is how a surface could quietly stop offering an agent by dropping a
      // branch. They are rows of the shared GROUP_AGENT_OPTIONS list (asserted above), and
      // the capability questions are answered from the agent catalog, so neither surface
      // keeps a private agent list any more.
      expect(source).toContain('const groupAgentTypeOptions = computed(')
      expect(source).toContain('isGlobalOnlyCodingAgent(selectedAgentType')
      expect(source).toContain('isNativeCodingAgent(selectedAgentType')
    }
    // The fork wrote `selectedAgentType.value === 'cursor'` because Cursor offers no scoped
    // mode. Upstream 0.8.20 answers the same question from config/agents.json
    // (cursor: modes ['global']), so the behaviour is asserted here instead: editing the
    // catalog to hand Cursor a scoped mode fails this guard rather than silently changing
    // which model fields a group room shows.
    expect(isGlobalOnlyCodingAgent('cursor')).toBe(true)
    expect(isNativeCodingAgent('cursor')).toBe(false)
    expect(panel).toContain('priorAgentMode.value = storedPriorAgentMode(agent.priorAgentMode)')
    expect(panel).toContain('priorAgentMode: priorAgentMode.value,')
    expect(panel).toContain('submittedCodingAgentSelection({')
    expect(linkView).toContain('priorAgentMode.value = storedPriorAgentMode(agent.priorAgentMode)')
    expect(linkView).toContain('priorAgentMode: priorAgentMode.value,')
    expect(linkView).toContain('submittedCodingAgentSelection({')
    const selection = readFileSync('packages/client/src/utils/coding-agent-mode.ts', 'utf8')
    expect(selection).toContain("priorAgentMode: input.priorAgentMode || ''")
  })

  it('keeps free-text input available alongside clarification choices in single and group chat', () => {
    // Both conversations render the one shared card, so free text and choices
    // cannot drift apart between them. They no longer share one markup shape
    // though: single chat renders one card per open prompt, group chat still
    // renders the room's first, so each is pinned against its own binding.
    const single = readFileSync('packages/client/src/components/hermes/chat/MessageList.vue', 'utf8')
    const singleMarker = single.indexOf('v-for="clarify in visibleClarifies"')
    const singleCard = single.slice(
      single.lastIndexOf('<PendingInteractionCard', singleMarker),
      single.indexOf('</Transition>', singleMarker),
    )
    expect(singleCard).toContain('<PendingInteractionCard')
    expect(singleCard).toContain(':choices="clarify.choices"')
<<<<<<< Updated upstream
    // Prettier in 0.8.20 typed the inline arrow parameters, so the handler reads
    // `(response: string) => handleClarifyFor(...)`. What matters is that submit,
    // select and dismiss all route through the per-prompt handler with the prompt bound
    // -- a card keyed by the wrong prompt answers the wrong agent.
    expect(singleCard).toMatch(/@submit="\(?\s*response[^)]*\)?\s*=>\s*handleClarifyFor\(clarify,\s*response\)"/)
    expect(singleCard).toMatch(/@select="\(?\s*response[^)]*\)?\s*=>\s*handleClarifyFor\(clarify,\s*response\)"/)
    expect(singleCard).toContain('@dismiss="handleClarifyFor(clarify, \'\')"')
    // A prompt with no choices must still render the card, otherwise a free-text-only
    // question has no answer control at all.
=======
    expect(singleCard).toContain('@submit="response => handleClarifyFor(clarify, response)"')
>>>>>>> Stashed changes
    expect(singleCard).not.toContain('v-if="clarify.choices')

    const group = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const groupMarker = group.indexOf('v-if="!visibleApproval && visibleClarify"')
    const groupCard = group.slice(
      group.lastIndexOf('<PendingInteractionCard', groupMarker),
      group.indexOf('</Transition>', groupMarker),
    )
    expect(groupCard).toContain('<PendingInteractionCard')
    expect(groupCard).toContain(':choices="visibleClarify.choices"')
    expect(groupCard).toContain('@submit="handleClarify"')
    expect(groupCard).not.toContain('v-if="visibleClarify.choices')

    const card = readFileSync('packages/client/src/components/hermes/chat/PendingInteractionCard.vue', 'utf8')
    expect(card).toContain('class="clarify-float-input-row"')
    expect(card).toContain('<NInput')

    // Approval, clarification and agent pairing all go through the same card.
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    expect(panel.match(/<PendingInteractionCard/g)).toHaveLength(3)
    expect(panel).not.toContain('class="approval-float-header"')
  })

  it('coerces null picker values before trimming so clearing the input saves an empty workspace', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("String(workspaceValue.value || '').trim()")
    expect(source).not.toContain('workspaceValue.value.trim()')
  })

  it('acknowledges the composer only after the asynchronous group send settles', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const handler = source.slice(
      source.indexOf('async function handleSendMessage('),
      source.indexOf('async function handleCancelQueuedExecution('),
    )

    expect(handler).toContain('const submittedRoomId = store.currentRoomId')
    expect(handler).toMatch(/await store\.sendMessage[\s\S]*clearGroupChatRoomDraft\(submittedRoomId\)[\s\S]*completeSend\?\.\(true\)/)
    expect(handler).toMatch(/catch[\s\S]*completeSend\?\.\(false\)/)
  })

  it('gates room management controls while allowing an Agent owner to handle a directed approval', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const visibleApproval = source.slice(
      source.indexOf('const visibleApproval = computed(() =>'),
      source.indexOf('const visibleClarify = computed(() =>'),
    )
    const approvalHandler = source.slice(
      source.indexOf('async function handleApproval('),
      source.indexOf('async function handleClarify('),
    )

    expect(source).toContain('const currentRoomCanManage = computed(() => !props.standalone && canManageRoom(currentRoom.value))')
    expect(source).toContain("const currentRoomCanMentionAll = computed(() => !props.standalone && currentRoom.value?.canMentionAll === true)")
    expect(visibleApproval).toContain('pendingAgentPairings.value.length === 0')
    expect(visibleApproval).not.toContain('currentRoomCanManage.value')
    expect(approvalHandler).not.toContain('currentRoomCanManage.value')
    expect(source).toContain('if (!currentRoomCanManage.value) return')
    expect(source).toContain('if (!canManageRoom(room)) return')
    expect(source).toContain("options.push({ label: t('chat.setWorkspace'), key: 'set-workspace' })")
    expect(source).toContain('v-if="currentRoomCanManage"')
    expect(source).toContain(':allow-all-mention="currentRoomCanMentionAll"')
    expect(source).toContain('class="agent-avatar-stop"')
    expect(source).toContain('...result.policy')
    expect(source).not.toContain('store.rooms[index] = result.room')
  })

  it('renders the active room workspace icon in the right header actions', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerInfo = source.slice(source.indexOf('<div class="header-info">'), source.indexOf('</PageHeader>'))

    expect(headerInfo).toContain('class="header-workspace-button"')
    expect(headerInfo).toContain('v-if="currentRoomCanManage"')
    expect(headerInfo).toContain(':title="currentRoom?.workspace || t(\'chat.setWorkspace\')"')
    expect(headerInfo).toContain('@click="handleOpenWorkspacePicker()"')
    expect(source).not.toContain('class="workspace-badge"')
    expect(source).not.toContain('class="workspace-chip"')
  })

  it('offers a selected manual room link when browser clipboard access fails', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain('const roomLink = buildRoomUrl(roomId)')
    expect(source).toContain('manualRoomLink.value = roomLink')
    expect(source).toContain('showManualRoomLinkModal.value = true')
    expect(source).toContain('manualRoomLinkInput.value?.select()')
    expect(source).toContain('v-model:show="showManualRoomLinkModal"')
    expect(source).toContain(':aria-label="t(\'groupChat.copyRoomLink\')"')
    expect(source).toContain("t('groupChat.manualCopyRoomLinkHint')")
    expect(source).toContain('ref="manualRoomLinkInput"')
  })

  it('shows rolling-summary progress above the input like a single-chat tool call', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerLeft = source.slice(
      source.indexOf('<div class="header-left">'),
      source.indexOf('<div class="header-info">'),
    )
    const inlineStatus = source.slice(
      source.indexOf('<Transition name="summary-inline">'),
      source.indexOf('<GroupChatInput'),
    )

    expect(headerLeft).not.toContain('room-summary-header-status')
    expect(inlineStatus).toContain('class="group-summary-inline-status"')
    expect(inlineStatus).toContain("inlineSummaryStatus.status === 'summarizing'")
    expect(inlineStatus).toContain('class="group-summary-inline-spinner"')
    expect(inlineStatus).toContain("inlineSummaryStatus.status === 'success'")
    expect(inlineStatus).toContain('class="group-summary-inline-success-icon"')
    expect(inlineStatus).toContain('class="group-summary-inline-error-icon"')
    expect(inlineStatus).not.toContain('group-summary-inline-type-icon')
    expect(source.indexOf('<Transition name="summary-inline">')).toBeLessThan(source.indexOf('<GroupChatInput'))
    expect(source).not.toContain("message.loading(roomSummaryStatusLabel('summarizing')")
    expect(source).not.toContain("message.success(roomSummaryStatusLabel('success'))")
  })

  it('keeps agent and other-member actions visible while showing self actions on hover', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')

    expect(source).toMatch(/\.message-meta\s*\{[^}]*opacity: 1;/s)
    expect(source).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.group-message\.self \.message-meta\s*\{[^}]*opacity: 0;/s)
    expect(source).toContain('.group-message.self:hover .message-meta')
    expect(source).toContain('.group-message.self:focus-within .message-meta')
    expect(source).not.toContain('.group-message.agent .message-meta')
    expect(source).not.toContain('.group-message.embedded .message-meta')
  })

  it('renders messages from other members in the same embedded card as agent runs', () => {
    const list = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    const card = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')

    expect(list).toContain('function isOtherMemberMessage(')
    expect(list).toContain('v-if="msg.runItems?.length || isOtherMemberMessage(msg)"')
    expect(card).toContain('props.message.runItems?.length ? props.message.runItems : [props.message]')
    expect(card).toContain(':avatar="senderAvatar"')
    expect(card).toContain('embedded')
    expect(card).toMatch(/\.run-column\s*\{[^}]*width: fit-content;[^}]*max-width: min\(85%, 920px\);/s)
  })

  it('matches the single-chat bubble radius without an outer agent run border', () => {
    const groupRunCard = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')
    const singleMessage = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')
    const runCardStyles = groupRunCard.slice(
      groupRunCard.indexOf('.run-card {'),
      groupRunCard.indexOf('.run-time {'),
    )

    expect(hasDeclaration(singleMessage, '.message-bubble', 'border-radius', '10px')).toBe(true)
    expect(runCardStyles).toContain('border: none;')
    expect(hasDeclaration(runCardStyles, '.run-card', 'border-radius', '10px')).toBe(true)
    expect(runCardStyles).not.toContain('border-color:')
  })

  it('opens summary settings and preserves the draft when a legacy room has no summarizer', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const input = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatInput.vue', 'utf8')

    expect(panel).toContain('const currentRoomNeedsSummaryConfiguration = computed(() => {')
    expect(panel).toContain("!String(room.summaryProvider || '').trim()")
    expect(panel).toContain("!String(room.summaryModel || '').trim()")
    expect(panel).toContain(':send-blocked="currentRoomNeedsSummaryConfiguration"')
    expect(panel).toContain('@send-blocked="handleSummaryConfigurationRequired"')
    expect(panel).toContain("message.warning(t('groupChat.summaryConfigurationRequired'))")
    expect(panel).toContain('void handleOpenRoomSettings()')
    expect(panel).toContain('summarySettingsSectionRef.value?.scrollIntoView')
    expect(input).toContain("emit('send-blocked')")
    expect(input.indexOf("emit('send-blocked')")).toBeLessThan(input.indexOf("inputText.value = ''"))
  })

  it('places the group files, terminal, and browser drawer control beside settings', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerInfo = source.slice(
      source.indexOf('<div class="header-info">'),
      source.indexOf('<NPopconfirm v-if="currentRoomCanManage" @positive-click="handleClearRoomContext">'),
    )

    expect(headerInfo).toContain('class="icon-btn workspace-panel-toggle"')
    expect(headerInfo).toContain('class="icon-btn compression-settings-button"')
    expect(headerInfo).toContain('@click="toggleWorkspacePanel"')
    expect(source).toContain("const activeWorkspacePanel = ref<'files' | 'terminal' | 'browser'>('files')")
    expect(source).toContain("selectWorkspacePanel('terminal')")
    expect(source).toContain('<TerminalPanel')
    expect(source).toContain("t('drawer.terminal')")
    expect(source).toContain("t('browser.title')")
    expect(source).toContain('class="group-tool-tabs"')
    expect(source).toContain('class="group-tool-content"')
    expect(source).toContain('class="group-workspace-empty"')
    expect(source).not.toContain(':disabled="!currentRoom?.workspace"')
    expect(source).toContain('flex-direction: row')
    expect(source).toContain('order: 2')
    expect(headerInfo.indexOf('workspace-panel-toggle')).toBeLessThan(headerInfo.indexOf('compression-settings-button'))
    expect(source).not.toContain('class="page-sidebar-menu-btn workspace-sidebar-button"')
  })

  it('renders room agents as an avatar-only rail on the left of the chat surface', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerInfo = source.slice(
      source.indexOf('<div class="header-info">'),
      source.indexOf('</div>', source.indexOf('<div class="header-info">')),
    )
    const rail = source.slice(
      source.indexOf('class="agent-avatar-rail"'),
      source.indexOf('<div class="group-chat-surface">'),
    )

    expect(headerInfo).not.toContain('avatar-stack-trigger')
    expect(rail).toContain('v-for="member in railMembers"')
    expect(rail).toContain(':key="member.userId"')
    expect(rail).toContain('v-for="agent in store.agents"')
    expect(rail).toContain('class="agent-avatar-rail-item agent-avatar-rail-agent"')
    expect(rail).toContain("'agent-avatar-rail-offline': agent.connectionStatus === 'offline'")
    expect(rail).toContain(':avatar="memberAvatarFor(member)"')
    expect(rail).toContain("'agent-avatar-rail-typing': member.userId !== store.userId && store.isUserTyping(member.userId)")
    expect(rail).toContain("'agent-avatar-rail-offline': member.connectionStatus === 'offline'")
    expect(rail).toContain('@click="handleRoomMemberClick(member)"')
    expect(rail).toContain('@click="handleAgentRailClick(agent)"')
    expect(rail).not.toContain(':disabled="!currentRoomCanManage"')
    expect(rail).toContain('class="agent-avatar-rail-add"')
    expect(rail).not.toContain('avatar-stack-more')
    expect(source).not.toContain('transform: translateY(-1px)')
    expect(source).toContain('const participantCount = computed(() => railMembers.value.length + store.agents.length)')
    expect(source).toContain('const showMemberRail = ref(true)')
    expect(source).toContain('@click="showMemberRail = !showMemberRail"')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('animation: member-avatar-typing-breathe 1.6s ease-in-out infinite')
    expect(source).toContain('@keyframes member-avatar-typing-breathe')
    expect(source).toContain('.agent-avatar-rail-offline')
    expect(source).toContain('filter: grayscale(1)')
    expect(source).toContain('opacity: 0.42')
    expect(hasDeclaration(source, '.agent-avatar-rail-agent .agent-avatar', 'border', '1px solid #fff')).toBe(true)
  })

  it('keeps invite-only chat free of settings and speech controls', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const input = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatInput.vue', 'utf8')
    const message = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')
    const agentMessageAvatar = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentMessageAvatar.vue', 'utf8')
    const agentRunCard = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')
    const sharedView = readFileSync('packages/client/src/views/hermes/SharedGroupChatView.vue', 'utf8')
    const linkView = readFileSync('packages/client/src/views/hermes/GroupChatLinkView.vue', 'utf8')
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')

    expect(panel).toContain(':show-settings="!props.standalone"')
    expect(panel).toContain(':allow-speech="!props.standalone"')
    expect(panel).toContain('v-if="currentRoomCanManage || props.standalone"')
    expect(panel).toContain("emit('requestAgentLink')")
    expect(panel).toContain("emit('requestAgentEdit', agent)")
    expect(panel).toContain("if (agent.connectionStatus === 'offline') return")
    expect(panel).toContain("currentRoomCanManage.value && agent.executorType !== 'remote'")
    expect(panel).toContain('class="agent-owner-avatar-badge"')
    expect(panel).toContain('function canRemoveAgent(agent: RoomAgent)')
    expect(panel).toContain('v-if="canRemoveAgent(agent)"')
    expect(panel).toContain('@click.stop="handleRemoveAgent(agent)"')
    expect(panel).toContain('@click="handleRemoveAgent(editingAgent)"')
    expect(panel).not.toContain("t('groupChat.deleteAgentConfirm'")
    expect(panel).toContain(':disabled="!canRemoveAgent(agent) && !agentContextStatus(agent)"')
    expect(panel).toContain("const ownerMemberId = currentRoom.value?.ownerMemberId || ''")
    expect(panel).toContain('if (ownerMemberId && member.userId === ownerMemberId) return 0')
    expect(panel).toContain('if (member.userId === store.userId) return 1')
    expect(panel).toContain('@click.stop="handleRemoveMember(member)"')
    expect(panel).not.toContain("t('groupChat.removeMemberConfirm'")
    expect(sharedView).toMatch(/<GroupChatPanel[\s\S]*?standalone/)
    expect(sharedView).toContain('@request-agent-link="openAgentLinkModal"')
    expect(sharedView).toContain('@request-agent-edit="openOwnedAgentEditor"')
    expect(sharedView).toContain('editConnectorId: agent.connectorId')
    expect(sharedView).toContain(':mask-closable="false"')
    expect(sharedView).toContain('/?groupChatAgentLink=1#/group-chat-link')
    expect(sharedView).toContain('v-model:value="targetOriginDraft"')
    expect(sharedView).toContain("const targetOriginDraft = ref('http://127.0.0.1:8748')")
    expect(sharedView).toContain("import { generateClientUuid } from '@/utils/client-random'")
    expect(sharedView).not.toContain('crypto.randomUUID')
    expect(sharedView).not.toContain('probeTargets')
    expect(sharedView).not.toContain('detectedTargetOrigins')
    expect(sharedView).not.toContain('class="agent-link-launcher"')
    expect(linkView).not.toContain('disconnectLocalGroupAgent')
    expect(linkView).not.toContain('disconnectConnection')
    expect(linkView).not.toContain('class="existing-connections"')
    expect(linkView).not.toContain('class="connection-row"')
    expect(linkView).not.toContain('class="connection-state"')
    expect(panel).toContain('listLocalGroupAgentConnections')
    expect(panel).toContain('buildRemoteGroupChatRooms')
    expect(panel).toContain("t('groupChat.localRooms')")
    expect(panel).toContain("t('groupChat.remoteRooms')")
    expect(panel).toContain('v-if="store.rooms.length"')
    expect(panel).toContain('v-if="remoteRooms.length"')
    expect(panel).toContain(':aria-expanded="!localRoomsCollapsed"')
    expect(panel).toContain(':aria-expanded="!remoteRoomsCollapsed"')
    expect(panel).toContain('handleSelectRemoteRoom(room)')
    expect(panel).toContain('/#/share/group-chat/${encodeURIComponent(room.inviteCode)}')
    expect(panel).not.toContain('/#/hermes/group-chat/room/${encodeURIComponent(room.roomId)}')
    expect(panel).toContain(':aria-disabled="!room.inviteCode"')
    expect(panel).toContain('@contextmenu="handleRemoteRoomContextMenu($event, room)"')
    expect(panel).toContain('renameLocalGroupAgentRoom')
    expect(panel).toContain('leaveLocalGroupAgentRoom')
    expect(panel).toContain("t('groupChat.leaveRemoteRoom')")
    expect(panel).toContain("t('groupChat.leaveRemoteRoomConfirm'")
    expect(panel).toContain("t('groupChat.renameRemoteRoom')")
    expect(panel).toContain("t('groupChat.remoteRoomRenameFailed')")
    expect(panel).toContain("t('groupChat.remoteRoomLeaveFailed')")
    expect(panel).not.toContain("t('common.rename')")
    expect(router).toMatch(/path: '\/group-chat-link'[\s\S]*?meta: \{ standaloneChat: true \}/)
    expect(input).toContain('v-if="props.showSettings"')
    expect(input).toContain('store.setAutoPlaySpeech(false)')
    expect(message).toContain('if (!props.allowSpeech) return false')
    expect(message).toContain('v-if="canPlaySpeech"')
    expect(message).toContain(':owner="agentOwnerInfo"')
    expect(message).toContain('class="sender-agent-icon"')
    expect(message).not.toContain('.group-message:not(.agent)')
    expect(agentMessageAvatar).toContain('class="message-agent-owner"')
    expect(agentMessageAvatar).toContain('class="message-agent-owner-badge"')
    expect(agentRunCard).toContain('class="run-agent-icon"')
    expect(linkView).toContain("type GroupAgentType = RemoteGroupAgentDescriptor['agent']")
    expect(linkView).toContain(':options="groupAgentTypeOptions"')
    expect(linkView).toContain(':options="profileOptions"')
    expect(linkView).toContain(':options="agentProviderOptions"')
    expect(linkView).toContain(':options="agentModelOptions"')
    expect(linkView).toContain(':options="agentReasoningEffortOptions"')
    expect(linkView).toContain('cloudOrigin !== parentOrigin.value')
    expect(linkView).toContain('!sameAgentDescriptor(input.agent, approvedAgent.value)')
    expect(linkView).toContain('class="manual-agent-preview"')
    expect(linkView).toContain("'hermes.group-chat.link-ready'")
    expect(linkView).toContain("'hermes.group-chat.parent-ready'")
    expect(linkView).toContain("'hermes.group-chat.selection-received'")
    expect(linkView).toContain("t('groupChat.agentLinkParentUnavailable')")
    expect(linkView).toContain("t('groupChat.agentLinkParentUnconfirmed')")
    expect(linkView).toContain("t('groupChat.agentLinkIncompleteConfiguration')")
    expect(linkView).toContain('connectLocalGroupAgentHandoff')
    expect(linkView).toContain('updateLocalGroupAgent')
    expect(linkView).toContain('editingConnection')
    expect(linkView).toContain('window.close()')
    expect(sharedView).toContain("data.type === 'hermes.group-chat.link-ready'")
    expect(sharedView).toContain("type: 'hermes.group-chat.parent-ready'")
    expect(sharedView).toContain("type: 'hermes.group-chat.selection-received'")
    expect(sharedView).toContain('createGuestAgentHandoff')
    expect(sharedView).toContain('pollPairingStatus()')
  })

  it('shows incoming guest Agent approvals immediately and in room settings', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const store = readFileSync('packages/client/src/stores/hermes/group-chat.ts', 'utf8')

    expect(store).toContain("socket.on('agent_pairing_requested'")
    expect(store).toContain("socket.on('agent_pairing_updated'")
    expect(panel).toContain('watch(() => store.agentPairingRevision')
    expect(panel).toContain('class="agent-pairing-header-button"')
    expect(panel).toContain('class="settings-section pending-agent-pairings-section"')
    expect(panel).toContain('@click="handleAgentPairingDecision(true, request)"')
    expect(panel).toContain('@click="handleAgentPairingDecision(false, request)"')
  })

  it('moves active agent status and interruption from the input status bar to the avatar rail', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("function agentContextStatus(agent: RoomAgent)")
    expect(source).toContain("'agent-avatar-rail-active': !!agentContextStatus(agent)")
    expect(source).toContain(':disabled="!canRemoveAgent(agent) && !agentContextStatus(agent)"')
    expect(source).toContain('function canStopAgent(agent: RoomAgent)')
    expect(source).toContain('agent.ownerMemberId === store.userId')
    expect(source).toContain('v-if="canStopAgent(agent) && agentContextStatus(agent)"')
    expect(source).toContain('@click.stop="handleInterruptAgent(agent)"')
    expect(source).toContain('animation: agent-avatar-rainbow-glow 4s linear infinite')
    expect(source).toContain('@keyframes agent-avatar-rainbow-glow')
    expect(source).toContain('0 0 0 2px #ff6b6b')
    expect(source).toContain('0 0 0 2px #48dbfb')
    expect(source).toContain('0 0 0 2px #5f27cd')
    expect(source).toContain('flex: 0 0 72px')
    expect(source).toContain('width: 72px')
    expect(source).not.toContain('class="status-bar"')
    expect(source).not.toContain(':title="`${agent.name}\\n${agentRuntimeLabel(agent)}`"')
  })

  it('renders the persistent room Agent grid in the stable leading room-list slot', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const roomAvatar = readFileSync('packages/client/src/components/hermes/group-chat/GroupRoomAgentAvatar.vue', 'utf8')
    const list = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    const runCard = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')
    const localRooms = panel.slice(
      panel.indexOf('v-for="room in store.rooms"'),
      panel.indexOf('<section v-if="remoteRooms.length"'),
    )
    const remoteRooms = panel.slice(panel.indexOf('<section v-if="remoteRooms.length"'))

    expect(localRooms).toContain('<GroupRoomAgentAvatar')
    expect(localRooms.indexOf('<GroupRoomAgentAvatar')).toBeLessThan(localRooms.indexOf('class="room-info"'))
    expect(localRooms).not.toContain('class="room-icon"')
    expect(remoteRooms).toContain('class="room-icon"')
    expect(remoteRooms).not.toContain('<GroupRoomAgentAvatar')
    expect(panel).toContain(':agents="store.roomAgentsForRoom(room.id)"')
    expect(panel).toContain(':active-agent-ids="store.activeAgentIdsForRoom(room.id)"')
    expect(roomAvatar).toContain('data-agent-count')
    expect(roomAvatar).toContain('room-agent-grid-neutral')
    expect(roomAvatar).toContain(`:class="{ 'is-active': hasActiveAgent }"`)
    expect(roomAvatar).toContain(':aria-busy="hasActiveAgent"')
    expect(roomAvatar).not.toContain(`:class="{ 'is-active': activeAgentIds.has(agent.id) }"`)
    expect(roomAvatar).not.toContain(`:class="{ 'is-active': overflowActive }"`)
    expect(roomAvatar).toContain('animation: room-avatar-rainbow-glow 4s linear infinite')
    expect(roomAvatar).toContain('@keyframes room-avatar-rainbow-glow')
    // The glow ring sits 4px outside the 36px grid cell, so its own radius has to stay 4px
    // above the cell's 8px or the ring clips the cell corners.
    expect(selectorBody(roomAvatar, '&.is-active::after')).toContain('inset: -4px;')
    expect(hasDeclaration(roomAvatar, '&.is-active::after', 'border-radius', '12px')).toBe(true)
    expect(roomAvatar).toContain('0 0 0 2px #ff6b6b')
    expect(roomAvatar).toContain('0 0 0 2px #48dbfb')
    expect(roomAvatar).toContain('0 0 0 2px #5f27cd')
    expect(roomAvatar).not.toContain('background: $success')
    expect(roomAvatar).toContain('@media (prefers-reduced-motion: reduce)')
    expect(list).toContain(':active="store.isAgentRunActive(')
    expect(runCard).toContain("'run-avatar-active': active")
    expect(runCard).toContain(':aria-busy="active"')
    expect(runCard).toMatch(/\.run-avatar\s*\{[^}]*border-radius: 50%;/s)
    expect(runCard).toContain('animation: run-avatar-rainbow-glow 4s linear infinite')
    expect(runCard).toContain('@keyframes run-avatar-rainbow-glow')
    expect(runCard).toContain('0 0 0 2px #ff6b6b')
    expect(runCard).toContain('0 0 0 2px #48dbfb')
    expect(runCard).toContain('0 0 0 2px #5f27cd')
    expect(runCard).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('shows agent runtime details when hovering message avatars and can insert a mention into the group input', () => {
    const panelSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const avatarSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentMessageAvatar.vue', 'utf8')
    const listSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    const itemSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')
    const runCardSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')

    expect(avatarSource).toContain('class="message-agent-popover"')
    expect(avatarSource).toContain("t('workflow.profile')")
    expect(avatarSource).toContain("t('profiles.provider')")
    expect(avatarSource).toContain("t('profiles.model')")
    expect(avatarSource).toContain('class="message-agent-mention"')
    expect(avatarSource).toContain("@click.stop=\"emit('mention', agent)\"")
    expect(hasDeclaration(avatarSource, '.message-agent-avatar > :deep(.profile-avatar-view)', 'border', '1px solid #fff')).toBe(true)
    expect(hasDeclaration(listSource, '.empty-agent-avatar', 'border', '1px solid #fff')).toBe(true)
    expect(listSource).not.toMatch(/\.empty-agent-avatar\s*\{[^}]*background:/s)
    expect(itemSource).toContain('<GroupAgentMessageAvatar')
    expect(runCardSource).toContain('<GroupAgentMessageAvatar')
    expect(runCardSource).not.toContain('run-agent-description')
    expect(panelSource).toContain('@mention-agent="handleMentionAgent"')
    expect(panelSource).toContain('groupChatInputRef.value?.insertMention?.(agent.name, agent.agentId)')
    expect(panelSource).not.toContain('class="agent-avatar-popover"')
  })

  it('loads persisted room summary state for the inline transcript anchor without a locate action', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain('async function loadRoomSummaryState(roomId: string)')
    expect(source).toContain('if (roomId && !props.standalone) void loadRoomSummaryState(roomId)')
    expect(source).not.toContain('handleLocateSummaryAnchor')
    expect(source).not.toContain('@click="handleLocateSummaryAnchor"')
  })

  it('fades the group chat surface when switching between rooms like single chat', () => {
    const groupSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    // Single chat no longer owns its fade: upstream lifted the identical reveal into one
    // composable that ChatPanel and PersonView both call. Reading ChatPanel for the
    // keyframes keeps passing even if the shared reveal were deleted, so the composable is
    // read directly and ChatPanel only has to prove it uses it.
    const revealSource = readFileSync('packages/client/src/composables/useChatSurfaceReveal.ts', 'utf8')
    const singleSource = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(groupSource).toContain('ref="groupChatSurfaceRef"')
    expect(groupSource).toContain('if (!roomId || !previousRoomId || roomId === previousRoomId) return')
    expect(groupSource).toContain('roomFadeAnimation?.cancel()')
    expect(groupSource).toContain('roomFadeAnimation = surface.animate(')
    expect(groupSource).toContain('duration: 1500')
    expect(groupSource).toContain("easing: 'ease'")
    expect(groupSource).toContain("{ flush: 'post' }")
    // Same keyframes, same 1500ms, same cancel-on-replace contract in both conversations.
    expect(revealSource).toContain('duration: 1500')
    expect(revealSource).toContain("easing: 'ease'")
    expect(revealSource).toContain('animation?.cancel()')
    expect(revealSource).toContain("flush: 'post'")
    // Importing the composable is not using it: assert the call is a statement in the
    // component body, so dropping the reveal while leaving the import behind fails here.
    expect(singleSource).toMatch(/^\s*useChatSurfaceReveal\(/m)
  })

  it('shows the refactor notice once and persists acknowledgement locally', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY = 'hermes.groupChat.refactorNotice.v1.acknowledged'")
    expect(source).toContain("window.localStorage.getItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY) !== '1'")
    expect(source).toContain("window.localStorage.setItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY, '1')")
    expect(source).toContain('v-model:show="showGroupChatRefactorNotice"')
    expect(source).toContain(':mask-closable="false"')
    expect(source).toContain(':close-on-esc="false"')
    expect(source).toContain("t('groupChat.refactorNoticeMessage')")
    expect(source).toContain('@click="acknowledgeGroupChatRefactorNotice"')
  })

  it('renders room creation and manageable room settings as right-side drawers', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const inviteCodeDraft = ref('')")
    expect(source).toContain('const canUpdateInviteCode = computed(() => {')
    expect(source).toContain('await store.setRoomInviteCode(store.currentRoomId, nextCode)')
    expect(source).toContain('<NDrawer v-model:show="showCreateModal" placement="right"')
    expect(source).toContain('<NDrawerContent :title="t(\'groupChat.createRoom\')" closable>')
    expect(source).toContain('v-model:show="showRoomSettingsModal"')
    expect(source).toContain('<NDrawerContent :title="t(\'groupChat.roomSettings\')" closable>')
    expect(source).toContain('v-model:value="roomNameDraft"')
    expect(source).toContain("updateRoomConfig(store.currentRoomId, { name: roomNameDraft.value.trim() })")
    expect(source).toContain("<h4>{{ t('groupChat.inviteCodeSettings') }}</h4>")
    expect(source).toContain('v-model:value="inviteCodeDraft"')
    expect(source).toContain('@click="handleSaveInviteCode"')
    expect(source).toContain("<h4>{{ t('chat.setWorkspaceTitle') }}</h4>")
    expect(source).toContain('<FolderPicker v-model="workspaceValue" />')
    expect(source).toContain('@click="handleSaveWorkspace"')
    expect(source).toContain(":title=\"t('groupChat.roomSettings')\"")
  })

  it('renders durable handoff stops under their source message with continue and settings actions', () => {
    const list = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(list).toContain('handoffChainFor(msg)')
    expect(list).toContain('data-handoff-chain-id')
    expect(list).toContain("emit('continueHandoff'")
    expect(list).toContain("emit('adjustHandoffSettings')")
    expect(list).toContain('props.canManageHandoff && handoffChainFor(msg)!.status')
    expect(panel).toContain(':can-manage-handoff="currentRoomCanManage"')
    expect(panel).toContain('@continue-handoff="handleContinueHandoff"')
    expect(panel).toContain('@adjust-handoff-settings="handleOpenRoomSettings"')
  })

  it('creates room agents with the single-chat api mode rules and keeps Hermes profile-owned', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const linkView = readFileSync('packages/client/src/views/hermes/GroupChatLinkView.vue', 'utf8')

    expect(source).toContain("const selectedAgentProvider = ref('')")
    expect(source).toContain("const selectedAgentModel = ref('')")
    expect(source).toContain("const selectedAgentApiMode = ref<CodingAgentApiMode>('codex_responses')")
    expect(source).toContain("const selectedAgentReasoningEffort = ref('')")
    expect(source).toContain('submittedCodingAgentSelection({')
    expect(source).toContain('usesGlobal: usesGlobalAgentMode.value')
    expect(linkView).toContain('submittedCodingAgentSelection({')
    expect(linkView).toContain('usesGlobal: usesGlobalAgentMode.value')
    const selection = readFileSync('packages/client/src/utils/coding-agent-mode.ts', 'utf8')
    expect(selection).toContain("agentMode: input.usesGlobal ? 'global' : 'scoped'")
    expect(selection).toContain("provider: input.usesGlobal ? '' : input.provider")
    // Upstream e1df360c1 (#3360) let a global-mode agent carry its own native model instead
    // of submitting an empty scoped model. That is the feature, not the regression. What has
    // to stay true is the scoped half: a global selection must never leak the scoped
    // provider or the scoped model into the payload, and it must still fall back to an
    // empty model when the agent has no native model selected.
    expect(submittedCodingAgentSelection({
      agent: 'claude', agentMode: 'global', priorAgentMode: undefined,
      provider: 'openrouter', model: 'claude-sonnet-4', usesGlobal: true, nativeModel: 'native-1',
    })).toEqual({ agent: 'claude', agentMode: 'global', priorAgentMode: '', provider: '', model: 'native-1' })
    expect(submittedCodingAgentSelection({
      agent: 'claude', agentMode: 'global', priorAgentMode: undefined,
      provider: 'openrouter', model: 'claude-sonnet-4', usesGlobal: true,
    })).toEqual({ agent: 'claude', agentMode: 'global', priorAgentMode: '', provider: '', model: '' })
    expect(submittedCodingAgentSelection({
      agent: 'claude', agentMode: 'scoped', priorAgentMode: undefined,
      provider: 'openrouter', model: 'claude-sonnet-4', usesGlobal: false,
    })).toEqual({ agent: 'claude', agentMode: 'scoped', priorAgentMode: '', provider: 'openrouter', model: 'claude-sonnet-4' })
    expect(source).toContain("apiMode: selectedAgentType.value === 'hermes' || usesGlobalAgentMode.value ? undefined : selectedAgentApiMode.value")
    // The submitted effort is scoped-only in scoped mode; in global mode it belongs to the
    // native agent, and the scoped effort is dropped when the surface switches. Asserting
    // the literal `? ''` would fail on #3360 while the guarantee it protects still holds.
    expect(source).toMatch(/reasoningEffort: usesGlobalAgentMode\.value \? nativeAgentSelection\.value\.reasoningEffort : agentReasoningEffortValue\.value,/)
    expect(source).toMatch(/selectedAgentReasoningEffort\.value = usesGlobalAgentMode\.value \? '' :/)
    // The paired link view has no native agent, so global mode there still submits nothing.
    expect(linkView).toContain("reasoningEffort: usesGlobalAgentMode.value ? '' : agentReasoningEffortValue.value")
    // Each surface drives its own model control: the room form goes through
    // ScopedModelSelector (@select), the invite link view keeps a plain select
    // (@update:value), and upstream renamed the room handler. The name is not the point --
    // picking a different scoped model must drop the scoped reasoning effort, or a stale
    // effort gets submitted against a model that never had it. Assert the handler each
    // surface actually wires up, and that the handler body clears the effort.
    function handlerBody(text: string, name: string): string {
      const at = text.indexOf('function ' + name + '(')
      if (at < 0) return ''
      const end = text.indexOf('\n}', at)
      return text.slice(at, end < 0 ? at + 400 : end + 2)
    }

    expect(source).toContain('@select="handleAgentModelSelect"')
    expect(handlerBody(source, 'handleAgentModelSelect')).toContain("selectedAgentReasoningEffort.value = ''")
    expect(linkView).toContain('function handleAgentModelChange(model: string)')
    expect(linkView).toContain('@update:value="handleAgentModelChange"')
    expect(handlerBody(linkView, 'handleAgentModelChange')).toContain("selectedAgentReasoningEffort.value = ''")
    expect(source).toContain('inferCodingAgentApiMode(')
    expect(source).toContain('normalizeCodingAgentApiMode(')
    // The protocol-scope picker must stay hidden for Hermes (there is no upstream
    // protocol to choose) and for a global-mode agent (the agent owns its own
    // configuration). Upstream added a third clause for a protocol the form already knows;
    // the two original clauses have to stay.
    expect(source).toMatch(/v-if="selectedAgentType !== 'hermes' && !usesGlobalAgentMode[^"]*"/)
    // The fork pinned the literal array because the two surfaces used to carry their own
    // copy and one could fall behind. Read the arrays instead of the literal so adding an
    // agent upstream does not break the guard, while the two properties that actually
    // matter still fail if they move: the room form and the invite link view must agree,
    // Cursor must be in the list (it has no scoped mode), and neither built-in agent may
    // ever be treated as global-capable.
    function globalModeAgents(text: string): string[] {
      const match = /const supportsGlobalAgentMode = computed\(\(\) => \[([^\]]*)\]\.includes\(selectedAgentType\.value\)\)/.exec(text)
      if (!match) return []
      return match[1].split(',').map(entry => entry.trim().replace(/^'|'$/g, ''))
    }

    const panelGlobalAgents = globalModeAgents(source)
    const linkGlobalAgents = globalModeAgents(linkView)
    expect(panelGlobalAgents.length).toBeGreaterThan(0)
    expect(panelGlobalAgents).toEqual(linkGlobalAgents)
    expect(panelGlobalAgents).toContain('cursor')
    expect(panelGlobalAgents).not.toContain('hermes')
    expect(panelGlobalAgents).not.toContain('ekko')
    for (const modelSource of [source, linkView]) {
      expect(modelSource).toContain("v-if=\"!usesGlobalAgentMode\"")
    }
    expect(source).toContain('@update:value="handleAgentModeChange"')
    expect(source).toContain('selectedAgentPresetId.value = null')
    expect(linkView).toContain('v-model:value="selectedAgentMode"')
    expect(source).toContain('agent: selectedAgentType.value')
    expect(GROUP_AGENT_OPTIONS).toEqual(expect.arrayContaining([
      { label: 'Hermes', value: 'hermes' },
      { label: 'Claude', value: 'claude' },
      { label: 'Codex', value: 'codex' },
      { label: 'Ekko', value: 'ekko' },
    ]))
    expect(source).toContain('v-model:value="agentName"')
    expect(source).toContain('v-model:value="agentDescription"')
    expect(source).toContain('avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value)')
    expect(source).toContain('@click="handleRandomAgentAvatar"')
    expect(source).toContain('@change="handleAgentAvatarFileChange"')
    expect(source).toContain(':avatar="groupAgentAvatar(agent)"')
  })
})
