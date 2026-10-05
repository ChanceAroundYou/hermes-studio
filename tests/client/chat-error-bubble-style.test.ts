import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const readClientFile = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

/**
 * A run failure used to render twice in two different styles: a red rounded
 * bubble for `run.failed` and a yellow left-striped system notice for anything
 * routed through a system message (bridge resume failures, swallowed model
 * errors, failed sends). Every error must now map to the one `.agent-error`
 * bubble.
 */
describe('error bubble styling is unified', () => {
  it('maps every system-level error to the one agent-error bubble', () => {
    const item = readClientFile('components/hermes/chat/MessageItem.vue')

    // Classification is structural: the role plus the `systemType: 'error'` tag
    // the store assigns. It must never inspect the message body, because a
    // text-based classifier repainted ordinary replies red.
    expect(item).toContain('return message.systemType === "error";')
    const start = item.indexOf('const isAgentError = computed')
    const body = item.slice(start, item.indexOf('});', start))
    expect(body).not.toContain('.content')
    // Command failures are errors too, so they share the one red treatment.
    expect(item).toContain('if (message.role === "command") return isCommandError.value;')
    // Two shapes, and only two. The third treatment -- an amber, left-striped
    // system bubble -- was described as retired in a comment while the class was
    // still applied, so an agent notice rendered in a style nothing else used.
    expect(item).toContain("'agent-error': isAgentError,")
    expect(item).toContain('notice: isSystemNotice,')
    // Progress is not a problem, so it must not be painted as one.
    expect(item).not.toContain("'agent-error': isAgentError || isSystemNotice,")
    // A system row with no `systemType` is a notice; anything with one is a
    // structured entry and keeps its own treatment.
    const noticeStart = item.indexOf('const isSystemNotice = computed')
    expect(noticeStart).toBeGreaterThan(-1)
    const notice = item.slice(noticeStart, item.indexOf(');', noticeStart))
    expect(notice).toContain('props.message.systemType === undefined')
    expect(notice).toContain('!props.message.compression')
  })

  it('has no second notice colour left in the stylesheet', () => {
    const item = readClientFile('components/hermes/chat/MessageItem.vue')
    // The amber treatment is deleted, not merely unused: leaving the rule behind
    // is how a style comes back the next time someone reaches for `system`.
    expect(item).not.toContain('warning-rgb')
    expect(item).not.toContain('$warning')
    // The row keeps a `system` class for layout (align-items), which is fine and
    // is not a colour; the bubble no longer receives one.
    expect(item).not.toMatch(/&\.system \{[^}]*background-color/)
  })

  it('routes the blocked family and the warn kind to the error row', () => {
    const store = readClientFile('stores/hermes/chat.ts')

    // The agent gives the lease notices no distinguishing structure: its status
    // callback carries a `kind`, but a lease wait and a compression are both
    // `lifecycle`. So "your turn has not started" is separated from "your turn
    // is running" by narrow machine signatures, the same shape of list the
    // failure classifier already uses.
    expect(store).toContain('const BRIDGE_BLOCKED_PATTERNS: RegExp[] = [')
    const blocked = store.slice(store.indexOf('const BRIDGE_BLOCKED_PATTERNS'))
    expect(blocked.slice(0, 900)).toContain('/^\\s*\\u23f3/')

    // Only `warn` is a problem; `lifecycle` is progress.
    expect(store).toContain('export function isWarningStatusKind')
    expect(store).toContain("isWarningStatusKind((evt as any).kind)")
    // All three reach the one error row.
    expect(store).toContain("|| isBridgeBlockedText(text) || isWarningStatusKind((evt as any).kind)) {")
  })

  it('routes a bridge failure carried as status text to the one error bubble', () => {
    const store = readClientFile('stores/hermes/chat.ts')
    const start = store.indexOf('function handleAgentEvent')
    expect(start).toBeGreaterThan(-1)
    const body = store.slice(start, store.indexOf('\n  }\n', start))

    // A payload arriving on `error` is a failure by construction, and some
    // bridge failures arrive as status *text* ("Non-retryable error (HTTP
    // 502): ..."). Both must reach `addAgentErrorMessage` instead of falling
    // through to the neutral amber system bubble, which is what made a single
    // failure render amber and then again red once it was persisted.
    expect(body).toContain('const isErrorEvent =')
    expect(body).toContain('isBridgeFailureText(text)')
    expect(body).toContain('addAgentErrorMessage(sid, text)')
  })

  it('keeps exactly one error colour in the stylesheet', () => {
    const item = readClientFile('components/hermes/chat/MessageItem.vue')

    // A failed command must not reintroduce a second amber error style.
    const commandError = item.slice(item.indexOf('&.command-error'))
    expect(commandError.slice(0, 220)).toContain('color: $error;')
    expect(commandError.slice(0, 220)).not.toContain('warning-rgb')
  })

  it('routes every store error producer through the unified error row', () => {
    const store = readClientFile('stores/hermes/chat.ts')

    // Swallowed model output used to be a warning-coloured system notice.
    expect(store).toContain(
      "addSystemErrorMessage(sid, 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.')",
    )
    // Failed sends used to be a warning-coloured system notice too.
    expect(store).toContain('addSystemErrorMessage(sid, `Error: ${err?.message || String(err)}`)')
    expect(store).not.toContain("content: `Error: ${err.message}`")
    // Bridge resume failures are errors, not status chatter.
    expect(store).toContain('addAgentErrorMessage(sid, text)')
  })

  it('gives every error row the same shape so a single bubble style applies', () => {
    const store = readClientFile('stores/hermes/chat.ts')
    const helperStart = store.indexOf('function addSystemErrorMessage')
    expect(helperStart).toBeGreaterThan(-1)
    const helper = store.slice(helperStart, store.indexOf('function handleSessionCommandEvent', helperStart))

    // The shape that drives the styling: a system row tagged as an error, so
    // one rule covers every failure no matter which path produced it. The
    // local-only marker that used to sit alongside is gone — the row is now
    // server-persisted like any other message.
    expect(helper).toContain("role: 'system'")
    expect(helper).toContain("systemType: 'error'")
    expect(helper).not.toContain('localOnly')
  })

  it('keeps nothing about errors in localStorage', () => {
    const store = readClientFile('stores/hermes/chat.ts')

    // Failures are persisted by the server as `role: 'error'`, so the client
    // keeps no parallel copy: no marker to preserve, no merge to re-apply them
    // on every transcript refresh, and nothing written to disk. These are
    // negative assertions on purpose — a full-transcript refresh that still had
    // to opt into restoring local rows would mean the duplication came back.
    expect(store).not.toContain('localOnly?: boolean')
    expect(store).not.toContain('mergeLocalOnlyMessages')
    expect(store).not.toContain('preserveLocalOnly')
    expect(store).not.toContain('rememberLocalError')
    expect(store).not.toContain('readStoredLocalErrors')
    expect(store).not.toContain('StoredLocalError')
    expect(store).not.toContain('carryOverLocalErrors')
  })

  it('never clears error rows together with transient agent-event notices', () => {
    const store = readClientFile('stores/hermes/chat.ts')

    expect(store).toContain(
      "s.messages = s.messages.filter(m => m.commandAction !== 'agent.event' || m.systemType === 'error')",
    )
  })
})
