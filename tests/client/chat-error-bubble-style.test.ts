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
    // The neutral warning-striped system bubble must not also render an error.
    expect(item).toContain('system: isSystem && !isAgentError,')
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
