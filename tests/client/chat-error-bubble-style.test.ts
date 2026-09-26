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

    expect(item).toContain('if (message.systemType === "error") return true;')
    expect(item).toContain('return /^\\s*(error\\b|run failed)/i.test(String(message.content || ""))')
    // The neutral warning-striped system bubble must not also render an error.
    expect(item).toContain('system: isSystem && !isAgentError,')
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

    expect(helper).toContain("role: 'system'")
    expect(helper).toContain("systemType: 'error'")
    expect(helper).toContain('localOnly: true')
  })

  it('marks injected errors local-only and preserves them across a re-map', () => {
    const store = readClientFile('stores/hermes/chat.ts')

    expect(store).toContain('localOnly?: boolean')
    expect(store).toContain('function mergeLocalOnlyMessages(')
    expect(store).toContain('options.preserveLocalOnly ? mergeLocalOnlyMessages(merged, previous) : merged')
    // Every full-transcript refresh opts in.
    const optIns = store.match(/preserveLocalOnly: true/g) || []
    expect(optIns.length).toBeGreaterThanOrEqual(5)
  })

  it('never clears error rows together with transient agent-event notices', () => {
    const store = readClientFile('stores/hermes/chat.ts')

    expect(store).toContain(
      "s.messages = s.messages.filter(m => m.commandAction !== 'agent.event' || m.systemType === 'error')",
    )
  })
})
