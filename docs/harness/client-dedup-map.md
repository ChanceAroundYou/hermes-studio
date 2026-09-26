# Client Deduplication Map

One implementation per concept. If a call site needs different output, add an
explicit option to the shared helper instead of a second copy: every copy listed
below had drifted before it was merged, which is why two screens could render the
same number differently.

## Single implementations

| Concept | Single implementation |
| --- | --- |
| Byte counts, compact token counts, epoch -> locale dates, error text | `packages/client/src/utils/format.ts` |
| Viewport breakpoints (768 phone layout, 640 full-width drawer) | `packages/client/src/utils/viewport.ts` + `packages/client/src/composables/useMediaQuery.ts` (`useMobileLayout`, `useNarrowDrawer`) |
| Provider OAuth login state machine and card | `packages/client/src/composables/useOAuthLoginFlow.ts` + `packages/client/src/components/hermes/models/OAuthLoginShell.vue` |
| Inline image / video detection | `packages/client/src/utils/attachments.ts` |
| Clarify, approval and custom pending interactions | `packages/client/src/components/hermes/chat/PendingInteractionCard.vue` |
| Time-ordered transcript insertion (compression cards) | `packages/client/src/utils/hermes/transcript-order.ts` |
| Chat composer height clamps | `packages/client/src/utils/chat-input-height.ts` |

Timestamps deliberately have three scoped homes, not one:

- `utils/format.ts` - an explicit epoch -> locale string for log and detail rows.
- `utils/chat-timestamp.ts` - day-aware bubble stamps (`10:20` today, `09/26, 10:20` this year).
- `shared/session-display.ts` - compact list-row stamps (`10:20` today, `Sep 26`).

## Do not merge these (same name, different meaning)

- `components/hermes/chat/MessageItem.vue` vs `components/hermes/group-chat/GroupMessageItem.vue`.
  Twelve functions share a name (`copyBubbleContent`, `formatToolPayload`,
  `renderToolPayload`, `handleSpeechToggle`, `isWorkspaceChangeExpanded`, ...)
  and **zero share a body**. Merging them means inventing behaviour for all
  twelve; align them one function at a time first.
- `components/hermes/chat/ChatPanel.vue` vs `components/hermes/group-chat/GroupChatPanel.vue`.
  Session semantics vs room semantics; only the genuinely shared pieces are
  extracted.
- `formatTime`: `LogsView.extractLogClock` (pull `HH:MM:SS` out of a log line),
  `TerminalView.formatClockTime` (clock only), `AccountSettings.formatRemainingMinutes`
  (a countdown). Three different jobs.
- `statusLabel`: separate dsh / mcp / ekko / plugins namespaces.

## How to re-check a claim before refactoring

Same-named functions across two files are not evidence of duplication. Extract
both `<script setup>` blocks and compare the function bodies, not the names: for
`MessageItem.vue` versus `GroupMessageItem.vue` that comparison is what showed
twelve same-named functions and zero identical bodies. Do the same before you
touch any other twin.

For anything already merged, prefer a behaviour test that pins the old output
(`tests/client/format-utils.test.ts`, `tests/client/viewport.test.ts`,
`tests/client/oauth-login-flow.test.ts`, `tests/client/pending-interaction-card.test.ts`)
over grepping the built bundle: the client build minifies names, so grepping for
a function or component name always returns zero hits. Assert on rendered text,
emitted events, or module exports instead.
