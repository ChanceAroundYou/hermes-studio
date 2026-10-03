import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
 *   - the profile display name in the profile selector, which was never
 *     wired at all: an empty new chat has no message header to hang the
 *     name off, so the selector is the label the user actually sees.
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
  pendingCard: read('packages/client/src/components/hermes/chat/PendingInteractionCard.vue'),
  groupChat: read('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue'),
  chatPanel: read('packages/client/src/components/hermes/chat/ChatPanel.vue'),
  chatStore: read('packages/client/src/stores/hermes/chat.ts'),
  chatInput: read('packages/client/src/components/hermes/chat/ChatInput.vue'),
  chatItem: read('packages/client/src/components/hermes/chat/MessageItem.vue'),
  sessionItem: read('packages/client/src/components/hermes/chat/SessionListItem.vue'),
  profileSelector: read('packages/client/src/components/layout/ProfileSelector.vue'),
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

  it('resolves the name in the profile selector on an empty new chat', () => {
    // This is the label a brand-new conversation actually shows: the
    // message header only renders once there is a message to carry it.
    expect(files.profileSelector).toContain(
      'resolveProfileDisplayName(profilesStore.profiles, activeProfileName.value)',
    )
    expect(files.profileSelector).not.toContain(
      "const displayName = computed(() => activeName.value || 'default')",
    )
    // Rows in the runtime list are labelled through the resolver too.
    expect(files.profileSelector).toContain('profileLabel(profile.name)')
    // Identity comparisons and API calls keep using the profile name.
    expect(files.profileSelector).toContain('profile.name === activeProfileName')
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

  it('leaves the option row layout to the card alone', () => {
    // Long options must size themselves. Three copies of
    // `.approval-float-actions` used to exist and the host copies re-imposed a
    // 2-column grid that clipped long choices, so whichever stylesheet loaded
    // last won. Ownership is the invariant: a host copy can only bring the
    // fixed grid back. The sizing declarations themselves are asserted in
    // clarify-option-sizing.test.ts.
    expect(files.pendingCard).toContain('.approval-float-actions')
    expect(files.messageList).not.toContain('.approval-float-actions')
    expect(files.groupChat).not.toContain('.approval-float-actions')
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
    // The run indicator owns no card of its own any more: an in-flight call is
    // grouped into the trailing transcript card, which is the bordered box the
    // finished calls already use.
    expect(files.messageList).toContain('ToolRunCard')
    expect(files.messageList).not.toContain('ToolRunSummary')
    expect(files.messageList).not.toContain('v-for="tc in visibleToolCalls"')
  })
})

/**
 * Upstream features this fork deliberately does not ship.
 *
 * Every other entry here asserts that something is *present*. These assert the
 * opposite, which is the harder direction: cherry-picking an upstream commit
 * silently reinstates the whole feature, and nothing in the build complains --
 * the page compiles, the route resolves, the nav entry renders. The only
 * signal is that it came back.
 */
describe('fork customization: deliberately removed upstream features', () => {
  const gone = [
    'packages/client/src/views/hermes/ApiRelayView.vue',
    'packages/client/src/components/hermes/ApiRelayUsageCard.vue',
    'packages/client/src/api/hermes/api-relay.ts',
    'packages/client/public/relay-logo.png',
    'packages/server/src/modules/hermes/controllers/api-relay.ts',
    'packages/server/src/modules/hermes/services/providers/api-relay-usage.ts',
    'packages/server/src/modules/studio/contracts/api-relay.ts',
    'tests/server/api-relay-usage.test.ts',
    'tests/e2e/api-relay.spec.ts',
  ]

  it('has no API relay feature files', () => {
    const resurrected = gone.filter(f => existsSync(f))
    expect(resurrected).toEqual([])
  })

  it('exposes no API relay route, endpoint or navigation', () => {
    // #3257 shipped the partner page; dropping the files alone would leave a
    // dead route and a dead nav entry pointing at nothing.
    expect(read('packages/client/src/router/index.ts')).not.toContain('hermes.apiRelay')
    expect(read('packages/client/src/App.vue')).not.toContain('hermes.apiRelay')
    expect(read('packages/client/src/components/layout/PageSidebarNav.vue')).not.toContain('apiRelay')
    expect(read('packages/client/src/components/layout/StudioNavigationRail.vue')).not.toContain('apiRelay')
    expect(read('packages/server/src/modules/hermes/routes/providers.ts')).not.toContain('api-relay')
  })

  it('keeps its i18n strings out of every locale', () => {
    // "饲料" in the zh sidebar came from upstream #1374, not from this fork, so
    // the removal has to sweep the locales or the string simply lingers.
    const locales = readdirSync('packages/client/src/i18n/locales').filter(f => f.endsWith('.ts'))
    expect(locales.length).toBeGreaterThan(0)
    const stale = locales.filter(f => read(`packages/client/src/i18n/locales/${f}`).includes('apiRelay'))
    expect(stale).toEqual([])
  })
})
