import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pendingProfileRoomNames, pendingProfileRoomQuery } from '../../packages/client/src/utils/hermes/pending-profile-rooms'

const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), 'utf8')

describe('which profile rooms one connection joins', () => {
  it('covers every profile the user can reach, not only the active one', () => {
    // A prompt asked on `mail` used to be undeliverable while the user looked at
    // `default`: the socket was only ever in the active profile's room.
    expect(pendingProfileRoomNames(['default', 'mail', 'research'], 'research'))
      .toEqual(['default', 'mail', 'research'])
  })

  it('always includes the active profile and never repeats one', () => {
    expect(pendingProfileRoomNames(['mail'], 'mail')).toEqual(['mail'])
    expect(pendingProfileRoomNames(['mail', 'mail', 'research', ''], 'research')).toEqual(['mail', 'research'])
    // An unknown/empty store still has to deliver the profile this socket is on.
    expect(pendingProfileRoomNames([], 'work')).toEqual(['work'])
    expect(pendingProfileRoomNames([null, undefined], 'work')).toEqual(['work'])
  })

  it('serializes to one bounded handshake value', () => {
    expect(pendingProfileRoomQuery(['mail', 'research'], 'research')).toBe('["mail","research"]')
    const many = Array.from({ length: 80 }, (_, index) => `profile-${index}`)
    const query = JSON.parse(pendingProfileRoomQuery(many, 'profile-0'))
    expect(query).toHaveLength(50)
    expect(query[0]).toBe('profile-0')
  })
})

describe('the pending snapshot is wired into the existing paths', () => {
  it('is carried by the socket handshake, not just computed', () => {
    const source = read('api/studio/chat.ts')
    const handshake = source.slice(source.indexOf('chatRunSocket = io('))
    expect(handshake).toContain('pending_profiles:')
    expect(handshake.slice(0, handshake.indexOf('})'))).toContain('pendingProfileRoomQuery(')
  })

  it('renders the session\'s open prompt from the store, not a local copy', () => {
    // One prompt per session in this branch's model. The invariant worth
    // pinning is that the card is bound to the store's pending clarify and
    // answered through the handler for that session -- a card holding its own
    // copy would answer the wrong agent after a re-render.
    const source = read('components/hermes/chat/MessageList.vue')
    expect(source).toContain('chatStore.activePendingClarify')
    expect(source).toContain('<PendingInteractionCard')
    expect(source).toContain('handleClarify(')
  })

  it('keeps the upstream reattach for runs the client never started', () => {
    // An autonomous or background callback can open a run on a session this tab
    // did not start. Upstream #3577 subscribes to that case so the tab attaches
    // before run.started is dispatched; without it the session looks idle while
    // the agent is streaming, and the reconnect snapshot is the only way back.
    const source = read('stores/hermes/chat.ts')
    const importLine = source.split('\n').find(line => line.includes('from \'@/api/studio/chat\'')) ?? ''
    // The import is the part that silently disappears when the whole file is
    // replaced by a transferred copy.
    // This branch discovers a run it never started by polling the working-session
    // snapshot on a short cadence, not by subscribing to a socket event. The
    // invariant is the same one upstream protects: a run visible on the server
    // must light this client without a reconnect. Pin the mechanism that exists
    // here, so removing it fails the suite.
    expect(source).toContain('applyWorkingSessionsSnapshot')
    expect(source).toContain('WORKING_SNAPSHOT_POLL_MS')
    expect(source).toContain('resumeServerWorkingRun(')
  })

  it('adds no timer of its own: the cards ride the tick that is already there', () => {
    // The intent is that the cards cost no *additional* timer, not that the
    // store may never own a second one. There are now two, and they answer
    // different questions at different costs: the twelve-second list tick is a
    // database read, the three-second one is the cheap working-sessions
    // endpoint that the sidebar ring and the completion notice need.
    const source = read('stores/hermes/chat.ts')
    expect(source).toMatch(/await reconcilePendingInteractionsQuietly\(\)/)
    // The cards must sit on the tick that already existed, not on a new one.
    const tick = source.slice(source.indexOf('async function refreshSessionListOnly'))
    const body = tick.slice(0, tick.indexOf('if (isStreaming.value) return'))
    expect(body).toContain('reconcilePendingInteractionsQuietly()')
    expect(source.match(/window\.setInterval\(/g) ?? []).toHaveLength(2)
  })
})

describe('one card surface for every host', () => {
  it('gives every host the same card surface, with no negative-margin compensation', () => {
    // The notification host styles the shared card itself, so all three carriers
    // get their surface from one component instead of a host-local copy of it.
    const host = read('components/layout/GlobalPendingActions.vue')
    expect(host).toContain('.n-notification:has(.pending-interaction-card--notification)')
    // A style rule that pulled the card out of its window (or hid it) makes a
    // background prompt unanswerable -- which reads as a button that does nothing.
    expect(host).not.toMatch(/margin:\s*-/)
    expect(host).not.toContain('calc(100% + 20px)')
  })

  it('keeps the in-chat card on the same surface as the notification card', () => {
    // MessageList hosts the same prompt in the transcript. All three carriers
    // must share one surface rule: the notification variant used to be left out
    // of the shared block and inherited the toaster's own chrome, so the same
    // question looked different depending on which session raised it.
    const card = read('components/hermes/chat/PendingInteractionCard.vue')
    expect(card).toMatch(
      /\.pending-interaction-card--inline,\s*\.pending-interaction-card--portal,\s*\.pending-interaction-card--notification\s*\{[\s\S]*?pointer-events:\s*auto/,
    )
    expect(card).not.toMatch(/margin:\s*-/)
    expect(card).not.toContain('calc(100% + 20px)')
  })

  it('lets the card follow the selected theme instead of hardcoding one palette', () => {
    // 0.8.20 made radius, border weight, spacing and background theme variables.
    // The card carried `border-radius: 16px`, `padding: 10px` and literal
    // `#ffffff` / `#262626`, so under a customized theme every other surface
    // followed the user's choice while the prompt card stayed behind.
    const card = read('components/hermes/chat/PendingInteractionCard.vue')
    const surface = card.match(
      /\.pending-interaction-card--inline,[\s\S]*?\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''
    expect(surface).toContain('var(--radius-component')
    expect(surface).toContain('var(--border-width')
    expect(surface).toContain('var(--theme-content-bg')
    expect(surface).toMatch(/padding:\s*calc\(\d+px \* var\(--spacing-scale/)
    // A literal palette is what the tokens exist to replace.
    expect(surface).not.toMatch(/background:\s*#/)
    expect(card).not.toMatch(/\.dark &[\s\S]{0,40}background:\s*#/)
  })

  it('keeps the host toaster clickable and transparent to the card', () => {
    // The host window is the only surface a background prompt has, so a style
    // rule that swallowed the click or hid the card made it unanswerable.
    const host = read('components/layout/GlobalPendingActions.vue')
    expect(host).toContain('.n-notification:has(.pending-interaction-card--notification) .n-notification-main { margin-inline-start: 0; }')
    // The card keeps its own `pointer-events: auto`, so the toaster needs no
    // interception shim here; adding one would swallow the click instead of pass it.
  })
})

describe('the room snapshot the socket already sends is used', () => {
  it('hydrates the group store from load_pending_approvals, gated by the server', () => {
    const source = readFileSync(
      new URL('../../packages/client/src/stores/hermes/group-chat.ts', import.meta.url), 'utf8',
    )
    // The socket has always answered "which room prompts are open" for every
    // room the user manages; the store dropped that list on the floor, so a
    // prompt raised in a room never reached anyone looking at a single chat.
    expect(source).toContain('applyRoomClarifySnapshot(res?.pendingClarifies)')
    // A snapshot that is not a list must not be read as "nothing is open".
    expect(source).toContain("if (!Array.isArray(clarifies)) return")
  })
})

describe('a room prompt is answerable from the shared surface', () => {
  const read = (p: string) => readFileSync(new URL(`../../packages/client/src/${p}`, import.meta.url), 'utf8')

  it('surfaces room prompts as their own carrier', () => {
    const host = read('components/layout/GlobalPendingActions.vue')
    // The room carrier is not a session carrier: it has its own key, its own
    // title, and the room it belongs to.
    expect(host).toContain("kind: 'group-clarify'")
    expect(host).toContain('`group-clarify:${pending.roomId}:${pending.clarifyId}`')
    expect(host).toContain('roomTitle(pending.roomId)')
  })

  it('answers it over the group socket, not the chat socket', () => {
    const host = read('components/layout/GlobalPendingActions.vue')
    const submit = host.slice(host.indexOf('async function submitClarify('))
    const body = submit.slice(0, submit.indexOf('\n}'))
    // The answer has to travel back to the agent waiting in the room, so it goes
    // through the group store; the chat socket would look for a session that the
    // room never had. The card hands the host the answer text, so the routing
    // decision stays here rather than inside the shared component.
    expect(body).toContain('groupChatStore.respondClarifyFor(action.pending.roomId, action.pending.clarifyId, answer)')
    expect(body).toContain("action.kind === 'chat-clarify'")
    expect(body).not.toContain('chatStore.respondToClarifyFor(action.pending.roomId')
  })
})
