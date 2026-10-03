import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The fork customization inventory, in one place.
 *
 * This fork tracks upstream by cherry-picking, and resolves structural conflicts
 * by taking upstream wholesale. That is right for layout rewrites but it
 * silently drops fork-only behaviour that lived in the same file, and the
 * behaviour's own unit tests keep passing because the unit under test never
 * changed -- only the call site did.
 *
 * Two regressions of exactly that shape have already happened:
 *
 *   - 79a7ae8a2: a fixed 120px gap below the thinking avatar, removed by #3232.
 *   - a440c83ac: the profile display name in the message header, dropped by
 *     #3232 the same way, leaving new chats labelled "default".
 *
 * So this file asserts the *wiring* of each customization: that the hook,
 * index, route or component is still referenced where it has to be. Behaviour
 * lives in the dedicated tests; this only answers "did the merge keep it".
 *
 * When a customization is intentionally replaced, update the entry rather than
 * deleting it, so the inventory stays a record of what this fork diverges on.
 */

const read = (path: string) => readFileSync(path, 'utf8')

const files = {
  messageList: read('packages/client/src/components/hermes/chat/MessageList.vue'),
  groupChat: read('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue'),
  chatPanel: read('packages/client/src/components/hermes/chat/ChatPanel.vue'),
  chatStore: read('packages/client/src/stores/hermes/chat.ts'),
  chatInput: read('packages/client/src/components/hermes/chat/ChatInput.vue'),
  chatItem: read('packages/client/src/components/hermes/chat/MessageItem.vue'),
  sessionItem: read('packages/client/src/components/hermes/chat/SessionListItem.vue'),
  folderPicker: read('packages/client/src/components/hermes/chat/FolderPicker.vue'),
  workspacePrefs: read('packages/client/src/composables/useWorkspacePreferences.ts'),
  avatarMap: read('packages/client/src/utils/chat-agent-avatar.ts'),
  indexHtml: read('packages/client/index.html'),
  schemas: read('packages/server/src/modules/studio/infrastructure/database/schemas.ts'),
  sessionStore: read('packages/server/src/modules/studio/repositories/session-store.ts'),
  taskPlanRuns: read('packages/server/src/modules/studio/services/task-plan-runs.ts'),
  profileRoutes: read('packages/server/src/modules/hermes/routes/profiles.ts'),
  bridgeRun: read('packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts'),
  chatRunSocket: read('packages/server/src/modules/studio/sockets/chat-run.ts'),
  groupChatSocket: read('packages/server/src/modules/studio/sockets/group-chat.ts'),
}

describe('fork customization: subpath deployment', () => {
  it('serves the PWA from /hermes/', () => {
    expect(files.indexHtml).toContain('/hermes/')
  })

  it('builds every agent icon path from the subpath base', () => {
    // A bare "/coding-agents/..." requests the server root under a subpath
    // deploy, so the icon 404s and the card renders blank.
    expect(files.avatarMap).toContain('getBaseUrlValue')
    expect(files.avatarMap).not.toMatch(/src: '\/(?!hermes)/)
  })

  it('gives every server self-connection the subpath socket.io path', () => {
    expect(files.groupChatSocket).toMatch(/basePath \? `\$\{basePath\}\/socket\.io` : '\/socket\.io'/)
  })
})

describe('fork customization: profile display name', () => {
  it('exposes a display-name route', () => {
    expect(files.profileRoutes).toContain("/api/hermes/profiles/:name/display-name")
  })

  it('resolves the name in the chat message header', () => {
    // a440c83ac wired this up and #3232 dropped it. Guard the call site, not
    // just the resolver: the resolver's own tests passed the whole time.
    expect(files.messageList).toMatch(/resolveProfileDisplayName\(\s*profilesStore\.profiles,/)
    expect(files.messageList).not.toMatch(/activeSessionProfile\.value\?\.alias\?\.trim\(\) \|\|/)
  })

  it('resolves the name in the sidebar session list', () => {
    expect(files.sessionItem).toContain('resolveProfileDisplayName')
  })
})

describe('fork customization: chat run stability', () => {
  it('reconciles a session back to idle after a run ends', () => {
    // 325f040aa: without this a finished session stays "thinking" forever and
    // the next message is queued behind it.
    expect(files.chatStore).toContain('reconcileSessionIdle')
  })

  it('keeps the bridge run handler free of the stale-loop isWorking race', () => {
    // Clearing isWorking inside the stale loop races the owner and drops the
    // final reply. Red line: never reintroduce it there.
    expect(files.bridgeRun).not.toMatch(/isWorking\s*=\s*false[\s\S]{0,200}stale/i)
  })

  it('clears the run leak and keeps a watchdog on the bridge socket', () => {
    expect(files.chatRunSocket).toMatch(/watchdog|clearRun|releaseRun/i)
  })

  it('lets the store read a session owned by another profile', () => {
    expect(files.chatRunSocket).toContain('requireSocketSessionAccess')
  })
})

describe('fork customization: failure presentation', () => {
  it('keeps one red error bubble instead of a system row', () => {
    // c15957f6e: a failure arriving as status text used to be persisted twice,
    // once neutral and once red.
    expect(files.chatStore).toContain('isBridgeFailureText')
    expect(files.chatItem).toContain("'command-error'")
  })

  it('keeps the failure where it happened', () => {
    expect(files.chatStore).toMatch(/systemType:\s*'error'/)
  })

  it('never feeds errors or commands to the model', () => {
    expect(files.sessionStore).toContain("role IN ('user', 'assistant', 'tool')")
  })
})

describe('fork customization: server authoritative state', () => {
  it('indexes the session page read', () => {
    // d18928e6a: without the composite index opening a chat scans the table.
    expect(files.schemas).toMatch(
      /idx_messages_session_page ON messages\(session_id, timestamp DESC, id DESC\)/,
    )
  })

  it('advances session activity from message timestamps', () => {
    expect(files.sessionStore).toContain('advanceLastActiveForSession')
  })

  it('keeps task-plan contexts alive across overlapping turns', () => {
    expect(files.taskPlanRuns).toContain('withTaskPlanTurnContext')
  })
})

describe('fork customization: client performance', () => {
  it('does not open a chat behind a redundant profile switch', () => {
    // c21a69590: the awaited promise was a no-op that delayed every open.
    expect(files.chatStore).toMatch(/if \(profileSwitch\) await profileSwitch/)
  })
})

describe('fork customization: shared interaction card', () => {
  it('routes single chat through the shared card', () => {
    // 9e91bc25 / 9b090471 / 176706176: one card owns approval, clarify and
    // pairing so single chat and group chat cannot drift apart.
    expect(files.messageList).toContain('PendingInteractionCard')
  })

  it('routes group chat through the same card', () => {
    expect(files.groupChat).toContain('PendingInteractionCard')
    expect(files.groupChat).toContain('agentPairingActions')
  })
})

describe('fork customization: workspace and session chrome', () => {
  it('keeps favourites on the server, not in localStorage', () => {
    expect(files.workspacePrefs).toMatch(/favorites/)
    expect(files.folderPicker).toMatch(/favorites/)
  })

  it('keeps touch long-press on the folder picker', () => {
    expect(files.folderPicker).toMatch(/touchstart|touchStart/)
  })

  it('keeps the workspace badge and outline toggle in the header', () => {
    expect(files.chatPanel).toContain('workspaceFolderName')
    expect(files.chatPanel).toContain('outline')
  })

  it('keeps the session title row', () => {
    expect(files.sessionItem).toContain('session-item-title-row')
  })
})

describe('fork customization: chat input behaviour', () => {
  it('sends with the button and only inserts a newline on mobile Enter', () => {
    expect(files.chatInput).toContain('isMobileViewport')
  })
})

describe('fork customization: run block layout', () => {
  it('does not reserve a fixed gap under the thinking avatar', () => {
    // 79a7ae8a2, removed by #3232 and reintroduced as a self-sizing block in
    // 5fdb2405b. Pin the rule body itself: a comment inside it breaks any
    // distance-based match, so read the block and assert on what it declares.
    const block = files.messageList.slice(files.messageList.indexOf('.streaming-indicator {'))
    const body = block.slice(0, block.indexOf('}'))
    expect(body).toMatch(/height:\s*auto/)
    expect(body).not.toMatch(/height:\s*(120px|\d+px)/)
  })

  it('spaces rows between themselves, not after the last one', () => {
    // a828c2ed9: padding on every row pushed the live run block an extra
    // rowGap away from the composer.
    expect(read('packages/client/src/components/hermes/chat/VirtualMessageList.vue')).toContain(
      '.virtual-row:not(:last-child)',
    )
  })

  it('shows live tools in the bordered card rather than a raw chip', () => {
    expect(files.messageList).toContain('ToolRunSummary')
    expect(files.messageList).not.toContain('v-for="tc in visibleToolCalls"')
  })
})
