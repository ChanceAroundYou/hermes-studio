# Upstream merge ledger

Tracks every upstream commit that is **not** yet in this fork, so each one can be
merged deliberately instead of drifting out of reach behind a long rebase.

Upstream: `origin` = `EKKOLearnAI/hermes-web-ui` (0.7.25). Merge base with this fork:
`b0555a0b3` (0.7.23). Every commit below is measured against **current `main`**, so
the conflict counts go stale as we merge. Re-measure before acting on a row.

Merged commits keep their upstream hash in the commit body (`(cherry picked from
commit <sha>)`), so `git log --grep='cherry picked from'` is the authoritative
record of what has already landed.

## How to merge one

```bash
git cherry-pick -x <sha>          # -x records the upstream hash
# resolve conflicts by hand, then:
git add <paths> && GIT_EDITOR=true git commit
```

Verify after **every** commit, not once at the end:

```bash
export PATH="/home/xiaokubao/.nvm/versions/node/v24.18.0/bin:$PATH"; hash -r
npx vue-tsc -b && npx tsc --noEmit -p packages/server/tsconfig.json
npx vitest run tests/client/     # 276 files / 1877 tests
BASE_URL=/hermes/ npm run build
```

Server has a standing baseline of **21 known failures**; compare the *name set*,
not the count. See `docs/harness/validation.md`.

## Not yet merged

| SHA | PR | Scope | Conflicts | Status |
|---|---|---|---|---|
| `8f14d5db2` | #3110 | Cursor CLI integration with isolated Studio MCP | **6 files / 6 hunks** | pending |
| `c19521d99` | #3232 | unify Studio navigation, headers and mobile layouts | **36 files / 74 hunks** | pending |
| `809e76ace` | #3191 | sidebar account menu + centred model loading | **4 files / 9 hunks** | pending |
| `c8ea5ba06` | #3226 | usage costs + local model pricing and limits | **4 files / 6 hunks** | pending |
| `83fff7d87` | #3199 | unify Agent picker order across chat and workflows | **5 files / 5 hunks** | pending |
| `5053c1346` | #3222 | product logo on Agent Manager cards | **5 files / 5 hunks** | pending |
| `458561cdb` | #3176 | desktop update progress + isolated test builds | **1 files / 3 hunks** | pending |
| `3d2fe623f` | #3151 | ignore legacy session push opt-out | clean | pending |

Conflict files are listed in `docs/upstream-merge-ledger.md`; the notes below record
*why* each one is risky against this fork's customisations.

## Blocked — rewrites our UI

### `c19521d99` — unify navigation, headers and mobile layouts

36 files / 74 hunks, 107 UI files. Introduces three new loading components
(`PageLoading.vue`, `StudioLoading.vue`, `logo-loading.css`) and rewrites `App.vue`
(396 lines). This fork's own work in the same files:

| File | Our change | Risk |
|---|---|---|
| `ChatPanel.vue` | workspace favourites on `workspacePreferences` + `StarIcon` | high |
| `ChatInput.vue` | coding-agent sessions hide the context limit | high |
| `MessageList.vue` | search-hit passthrough and tool-run grouping | medium |
| `AppSidebar.vue` | sidebar customisation | medium |
| `FolderPicker.vue` | star icon (4-line change) | low |

It does **not** touch `chat.ts`, `MessageItem.vue` or `tool-run-grouping.ts`, so the
error styling and the store rewrite are safe from this commit.

### `809e76ace` — sidebar account menu

4 files / 9 hunks. Extracts the whole sidebar footer (logout, status lamp, language
switch, version, update button, changelog modal) into a new `PageSidebarFooter.vue`
and leaves `<PageSidebarFooter />` behind. `ProfileSelector`'s avatar becomes a
`<button>`.

Verified: it does **not** touch workspace-favourite code. `ModelsView` only changes
the loading spinner markup. Still blocked because it replaces the sidebar footer
this fork has customised.

## Mergeable — low conflict, self-contained

### `3d2fe623f` — ignore legacy session push opt-out

Zero conflicts. Touches push consumer behaviour only.

### `458561cdb` — desktop update progress

1 file / 3 hunks (`docs/harness/validation.md`). Adds
`DesktopUpdateDownloadTab.vue` and wires it into `PageSidebarNav`. Pairs with
`a485b57d6`, already merged.

### `83fff7d87` — unify Agent picker order

5 files / 5 hunks, one per picker (`ChatPanel`, `GroupChatPanel`,
`GroupChatLinkView`, `WorkflowView`). Extracts the shared order into
`packages/client/src/utils/agent-options.ts`:

```
Hermes, Ekko, Claude, Codex, Pi, Grok, OpenCode, DeepSeek Harness, Cursor
```

Worth taking on its own: this fork's pickers are not consistent across pages.
Depends on `8f14d5db2` for the Cursor entry.

### `5053c1346` — product logo on Agent Manager cards

5 files / 5 hunks, all avatar/icon resolution. Follows `8f14d5db2`.

### `8f14d5db2` — Cursor CLI integration

6 files / 6 hunks despite 173 changed files — most land cleanly. Touches four files
this fork has rewritten, including `chat.ts`:

- `MessageItem.vue` — localises five native-usage command results
  (`nativeUsage`, `nativeUsageUnknown`, `nativeContextUnknown`,
  `nativeContextEstimate`, `nativeCompactUnavailable`). Valuable on its own.
- `chat.ts` — store changes for the Cursor runtime.
- `ChatInput.vue`, `MessageList.vue` — agent-specific rendering.

### `c8ea5ba06` — usage costs and local model pricing

4 files / 6 hunks. `DailyTrend.vue` and `StatCards.vue` conflict with this fork's
usage customisation; `UsagePricing.vue` (76 lines) is a new self-contained
component and `docs/harness/usage-cost.md` is documentation.
