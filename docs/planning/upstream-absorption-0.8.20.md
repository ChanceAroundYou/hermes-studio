# 上游升级吸收清单（Studio 0.7.23 → 0.8.20）

> 状态：**已取证、未执行**，2026-11-09。按本机 skill 纪律（先取证、报告、等确认再动手）整理，列出哪些值得吸收、哪些不值得、哪些各取所需。
> 起点：本地 `main` = `952d4efcd`（fork/本地 219 提交），合并基 `b0555a0b3`（Studio 0.7.23），上游 `origin/main` (`cedaceaef`)。
> 未提交改动已完整存入 `stash@{0}`（标签 `preserved 2026-10-06 governance work (merge-trial)`）；已 `git merge --abort`，工作区干净。试探性 merge 产生 **499 个冲突文件**。

---

## 一、总览

| | 数量 |
| --- | --- |
| 本地领先 | **219** 提交 |
| 落后上游 | **355** 提交 |
| 上游新增文件 / 修改 / **删除** | 753 / 559 / **770**（2097 文件，+114,551 / −227,762 行） |
| 双方都改过的交集 | **771** 文件 |
| 试探 merge 冲突 | **499** 文件 |
| 其中 85 个上游提交触及本次改动文件 | 其余 270 个不在本次改动面上 |

**结构性事实（决定了吸收方式）**：

1. **上游删掉了 `/tests` 下 1140 个文件（`081b9393f` 清空旧测试并精简 CI）**。经取证，我改过的全部 5 个测试文件（`clarification-runs.test.ts`、`clarifications-controller.test.ts`、`global-pending-actions.test.ts`、`chat-stop-recovery.test.ts`、`chat-store-error-handling.test.ts`）在上游**不存在**。
2. **上游没有做访类型交互治理**：无 `pending_interactions` 表、无快照接口、无 `contracts/pending-interaction.ts`；仍保留单个 `pending-interactions:${profile}` 房间，仍有 `emitPendingInteraction` 的 `group_chat` 早期返回。**"不顶掉根治"等设计是本地独有的，不会被上游覆盖。**
3. 上游新增 **Person 协作** 子系统（`person-interaction:` 前缀的 clarify 分支；50 个相关提交），让 `chat-run.ts` 的 clarify 路径变得复杂——这是吸收 `chat-run.ts`/`chat.ts` 改动时最大的风险面。

---

## 二、值得吸收的改动（14 条）

> 分类标准：与本次治理同主题（pending 持久化 / 对账 / abort 结算 / 投递范围 / 越权边界）、与现有症状相关、或删得太多会明显落后。

### A. 与本次治理同主题（**必吸收**，7 条）

| 提交 | 内容 | 为什么值得 | 与本地改动的交集 |
| --- | --- | --- | --- |
| `95d4ea3e7` (#3602) | restore Person push state and **pending interactions**：从 live approval brokers 恢复 pending（`ekko/services/clarifications.ts` +17、`approvals.ts` +21），chat-run.ts +18 | 与本任务**同主题（pending 恢复）** | `chat-run.ts`（我也改了） |
| `6a9c1e6b2` (#3723) | Index pending Person deliveries by origin session | 同主题：pending 索引（不同载体） | 无（新文件） |
| `055a7b8cc` (#3620) + `cf2d1358d` (#3622 revert) | 重连/回前台按服务端对账后台会话运行态，**随后被 revert** | 即本任务 Phase 3/Phase 6 的"自愈"；revert 是警告：**吸收其意图，不吸收其代码**，且应避免它踩过的坑 | `chat.ts` store |
| `4b98b347e` (#3321) | Hermes run state **recovery and finalization**；abort.ts 146 行重写 | run 定稿语义与 abort 结算同主题 | `abort.ts`（我没有改该文件，但测试被删） |
| `ff5058498` (#3473) | Stop the thinking indicator **after abort completion**（MessageList 2 行） | 停止/abort 显示语义，与 Phase 5 的 reason 语义相关 | `MessageList.vue`（我改了） |
| `1a2d4bba0` (#3330) | fix Hermes **clarify callbacks** across kernel versions（bridge_pool +114，测试 +176） | Python 桥 clarify 回调跨版本兼容 | 无（Python 侧，我未改） |
| `bc9ec0879` (#3544) | separate task plan identity from **turn context** | task plan 身份与轮次上下文解耦——与本任务 D2 的精确结算同主题 | `chat-run.ts` |

### B. 与现有症状相关 / 能改善可靠性（4 条）

| 提交 | 内容 | 说明 |
| --- | --- | --- |
| `8fdc953f4` (#3582) | sync **session activity and unread state across devices**（session-state store、跨设备） | 42 文件、跨设备同步；与快照对账同主题，需警惕引入**第二套对账** |
| `e65030bf2` (#3404) | 一次性合批 30+ 项修复：**访问控制**（`/api/auth/locked-ips` 须超管、媒体输出路径收紧）、chat 回收、abort 停止时不等待唤醒、bridge worker 活跃探测 | 含 **Phase 3 入房越权边界**的鉴权改动，需取证后吸收 |
| `23d4f5a72` (#3414) | **queue recall and workspace overlap boundaries** | 若还在用多会话共享 workspace，值得吸收 |
| `028b67068e` (#3615) | 排除点目录，`.deleted` 墓碑不再被列为 profile | 7/7 profile 均可见且可维护时值得；本机 profile 目录布局若命中则吸收 |

### C. 结构性教训（不吸收代码，但必读，避免重蹈）（3 条）

| 提交 | 教训 |
| --- | --- |
| `081b9393f` (#3645) | 上游清空 1140 个旧测试。**本任务 5 个改过的测试文件在上游已不存在**——说明上游已默认"测试文件可被整体替换"。升级后本任务测试需迁到新基线，否则 219 提交被合回时会遮蔽 |
| `c19521d99` (#3232) | 统一导航/头部/移动布局，曾**覆盖本地改动**（`1c8692c07`）；吸收前端改动时必须先取证版本 |
| `30b3e6209` (#3505) 把 `dc993207e` (#3495) revert | "route command approvals through Studio" 被 revert——与 authorize 行为未定性问题相关，**未定性前勿动** |

---

## 三、不值得吸收的（270 条中的大部）

| 类别 | 数量 | 原因 |
| --- | --- | --- |
| **Person / Bot 协作** | ~50 | 新子系统，另有 `person-interaction:` 前缀 clarify 分支；本次任务无此载体，吸收会把 `chat-run.ts`/客户端 clarify 显著复杂化 |
| **桌面端 / ESP32 / MCU** | 32 | 本机 D5 已明确"不需要桌面端" |
| **编码代理**（Cursor/Antigravity/Opencode/DSH 等） | ~36 | 本机在用编码代理管理规整，极少用到上游新增集成；且上游 App/浏览器/MCU 均不在被维护范围 |
| **浏览器自动化 / JEV** | ~26 | 与 clarify/approval 无关 |
| **群聊重构/多选删除/usage 显示等** | ~13 | 与 room-scope 投递无关 |
| **Workflows 新节点/图编辑** | 4 | 与本任务无交集 |
| **模型/用量/定价导入** | ~25 | 展示层，无治理价值 |
| **前端表现**（主题/Agent 卡片/抽屉） | ~15 | 视觉变更，且本地已做 profile display-name 接线（`55a212c03`），吸收易引入新漂移 |
| **推送 / Live Activity / iOS** | ~14 | 本机走 Web 客户端，非原生推送 |
| **版本发布 / changelog** | 29 | 仅版本号与文档 |
| **其它文档/杂项** | 64 | 文档与杂务 |
| 其中上游**删除了但值得吸收的** | 770 删除中 | 删除的大多是旧测试与旧桌面/编码代理实现，**不应被吸收**；只有 B/C 类的少数 deletions 属于治理相关 |

---

## 四、本任务改动在上游中的状态（★ 最重要的结论）

| 我的改动面 | 上游状态 | 结论 |
| --- | --- | --- |
| `pending_interactions` 表 + 快照 + 对账（Ph1–3） | **上游完全没有** | 不会被覆盖；升级后继续在 0.8.20 上叠加 |
| 不顶掉根治（Ph4） | **上游没有** | 无冲突概念；需移植到新 `chat-run` 结构 |
| abort reason 语义 + 看门狗（Ph5） | 上游改了 `abort.ts` 146 行 + Stop 指示灯 | **需对照移植**（A 类的 `4b98b347e`/`ff5058498`） |
| 单投递 dispatcher（Ph6） | 上游新增 Person clarify 分支 | 移植时必须把 Person 分支纳入 |
| 错误码/拒绝日志（Ph7） | 上游未做 | 无冲突 |
| `announcedKeys` 播报时机（Ph8） | **测试文件已删** | 功能移植、测试重建 |
| Phase 9 / 11 | `group-chat.ts` 与 `App.vue` 均有改动 | 需按新锚点移植（尤其 App.vue 的挂载条件） |

---

## 五、吸收方式的两种方案（待你确认）

> 按本机 skill 纪律：方案先给，确认后才动手。

1. **选择性提取（低风险，推荐）**：把 §二 的 14 条按提交逐个 `git show` 取 patch，只吸收其中的核心改动到新基线（`origin/main`），不整提交合入。**工作量小、冲突定义清晰**，且不需要搬动 219 提交。
2. **整分支 replay**：把 219 本地提交 rebase 到 `origin/main`，然后逐冲突处理+测试验证。本质是解 499 冲突，工作量与风险最高。
3. **保持现状**（不升级）：0.7.23 基线 + 219 提交 + 本次 41 文件改动继续维护，将来再随版本移动。

需要先决定 §二 中具体吸收哪几条，之后我按 TDD 逐条移植。

---

## 六、吸收执行状态（2026-11-09 基线快照）

> 本节记录**实际执行结果**，与上面的“计划态”分类并存。基线 = worktree `absorb-worker`，detached HEAD
> `cedaceaef`（Studio 0.8.20），**未提交**。
>
> 门禁：`npx vite build` **通过**；`npx vue-tsc -b --force` **0 错误**；
> `npx tsc --noEmit -p packages/server/tsconfig.json` **0 错误**。
> 治理测试集 **181/182 → 修断言后 8/8**（`pending-card-enter`）。
> 客户端全量 **389 / 427**，38 失败全部归因到下列「待处理」单元。

### A. 已吸收（有测试守卫）

| 单元 | 内容 | 状态 |
| --- | --- | --- |
| 待办交互治理 | `pending_interactions` 表、快照接口、D1–D5、房间越权 `canReadGroupChatRoom` 失败闭合 | 已吸收 · 曾通过 · 本轮复跑 181/182 |
| `sessionTasksEnabled` 透传 | **上游 0.8.20 能力**，我们的重写接住了参数却没往下传，导致每次会话目标请求 409 | 已吸收 · 3/3 变异杀死 |
| `listWorkingSessions` | 整个方法缺失，`/working-sessions` 接口恒返回 `[]` | 已吸收 · 7/7 测试 · 6/6 变异 |
| 压缩功能（服务端） | `compression-record.ts` 106 行、进度快照、`/compress`、bridge 自动压缩、resume 载荷 | 已吸收 · 4/4 测试 |
| 压缩功能（客户端） | `readCompressionRecord`、record/settle/merge/reconcile、3 处 resume、16 个事件点带 `source`/`startedAt`、去掉 5 秒自动隐藏、`run.started` 不再清记录 | 已吸收 · 9/9 行为测试 |
| 卡片主题令牌 | `PendingInteractionCard.vue` 从硬编码调色板改为 `--radius-component` / `--spacing-scale` / `--border-width` / `--theme-content-bg` | 已吸收 · 4/4 变异 |
| 审批提示上卡片 | 授权码、记忆写入单 Agree、命令预览、倒计时、select 路由 | 已吸收 · 6/6 变异 |
| 工具调用分组 | option A：连续块规则，**含正在执行中的调用**，无 live tool strip | 已吸收 · 6/6 变异 |
| profile 显示名 | 服务端 service + route + client API + Modal + 11 处调用点 | 已吸收 · 26 测试 · 12/12 变异 |
| `interrupted` 语义 | 采用上游 #3404 收窄后的表达式 | 已吸收 · 6/6 变异 |
| 未观测 run 重连 | `onUnobservedRunStarted` 订阅（上游 `af2d7ac6a`） | 已吸收 · 12/12 |
| 房间提示只达房间成员 | `canSee` 判定，storage 缺失时失败闭合 | 已吸收 · 11/11 · 5/5 变异 |
| 客户端压缩变更/停止 | `requestRunAbort` / `emitAbortOnSessionSocket` / `isSessionWorking` 闸门 | 已吸收 · 5/5 |
| 错误行不合并 | 保留 fork 的“就地覆盖 100 字符”移除，改追加独立错误行 | 已吸收 · 10/10 |

### B. 保留分歧（有意不跟随上游）

| 项 | 决策 |
| --- | --- |
| 工具调用分组规则 | 采用 fork 的连续块规则（已部署 0.7.27 行为），**不**采用上游 `b510c7795` 的 run 作用域规则 |
| `beginTaskPlanRun` 不调 `clarificationRuns.finishSession` | 保留 D2：按 contextId 精确结算，不在开新轮时清扫 |
| 卡片配色 | 用 fork 硬编码视觉的**令牌化版本**，不直接搬上游配色 |
| `CompressionProgress` 无 `source` 字段 | 服务端快照不带，客户端从事件载荷推导 |
| `NInput` 位置 | 已迁入 `PendingInteractionCard.vue`，不视为丢失 |
| 本地不跟随上游 `0ee02be8b` / `2f1686c03` | 已被治理重写替代（`beginTaskPlanRun` 局部 `runState`、多行 profile-room 加入循环） |
| `HistoryView` 只处理 `display_role === 'compression'` | 上游不再写 `role: 'error'` 行；那是**另一个**未吸收的 fork 服务端改动，不顺手带入 |

### C. 待处理（38 个客户端失败的唯一来源）

| 单元 | 规模 | 解锁 | 阻碍测试 |
| --- | --- | --- | --- |
| ~~`sessionRuns` 单写者重构 + 3 秒快照轮询~~ | **已吸收**：32 个旧写入点全部改由 `patchSessionRun` 单写，`serverWorking`/`streamStates`/`backgroundPendingBySession`/`runStartedAt` 变成派生视图 | 已解锁 | `working-poll` 15/15、`sidebar-live-settle` 21/21、`session-list-activity-regression`、`compression-reconcile` 6/6 |
| slash 自定义技能菜单 | `slash-command-skills.ts` 已恢复（168 行）但 `ChatInput.vue` **0 引用** | 10 个 | `chat-input-slash-menu` |
| `chat.ts` 去重 / 历史 profile 过滤 / 直连拉取 / 系统错误行 | 5 组标识符 | 2 个 | `chat-store-compression-state` 2 |
| 其余 63 个 fork 独有源文件 | `DevicesView`、`workspace-preferences`、`OAuthLoginShell`、`transcript-order`、`reasoning-effort-resolve` 等 | — | 当前 **0 处引用**，无实时断链 |
| 9 种语言 locale | 各缺 270–343 行 | — | — |
| E2E 4 个 spec | `pending-interaction-cross-session`、`clarify-option-touch-target`、`group-chat-room-deeplink`、`navigation-rail` | — | 本轮未复跑 |

### G. `sessionRuns` 单写者重构：实测结论（2026-11-09）

**做法**：没有搬 fork 的 94 冲突区补丁，而是在 0.8.20 基座上重建同一个不变量——每个会话一条
记录、一个写入者、一个读取者。32 个旧写入点（`serverWorking.add/delete`、`streamStates.set/delete`、
`backgroundPendingBySession.set/delete`、`runStartedAt.set/delete`）全部改走 `patchSessionRun`，
四个旧 Map 变成 computed 视图。脚本对每处锚点断言出现次数，不匹配就整份文件不落盘。

**过程中暴露的五个真实缺陷**（都不是吸收引入的，是被这次重构照出来的）：

1. **`runStartedAt` 与 `sessionRuns` 双真相。** 记录建起来后旧 ref 还在，快照否决条件读的那份时钟恒为 0，
   于是「快照竞态」被判成「泄漏标志」。改写为派生视图后 36/36 通过。这是单写者重构唯一真正的价值点。
2. **快照先于会话列表执行。** `applyWorkingSessionsSnapshot` 必须在列表抓取之前跑（否则手机上永远看不到
   别的会话在工作），因此委派计数循环不能遍历 `sessions.value`——那时它是空数组，计数被整段跳过。
   改为遍历「双方已知 id 的并集」，并让 `setBackgroundPending` 先落值后查 profile。
3. **`markSessionIdle` 清掉了 `delegations`。** 委派不属于一次运行、可以比运行活得更久，只能由快照结算。
4. **`dropped` 在写入者跑完之后才读键集**，读到空集，本轮该结算的会话一个都没结算。改为轮询开始前快照。
5. **停止按钮在看门狗放弃后永久失灵。** 看门狗放弃 ≠ 运行结束；`abortState.error` 是「试过但没确认」的凭据，
   下一按必须放行。同时给 abort 句柄加 `kind`：运行级句柄拒绝 → 回退会话 socket；会话级句柄拒绝 → 如实报死。

**门禁**：`vite build` ✓、`vue-tsc -b --force` 0 错误、服务端 `tsc` 0 错误、治理集 **182/182**、
客户端 **426/445**（余 19 = 7 个既有 `readFileSync` 缺陷 + 10 个 slash 菜单 + 2 个其余 `chat.ts` 分组）。

### D. 既有缺陷（非本次吸收造成，不计入回归）

`tests/client/compression-transcript-entry.test.ts` 有 7 个源码守卫测试报 `readFileSync is not a function`。
在 **fork 原树**（`/home/xiaokubao/.local/share/hermes-web-ui`）同样 7 失败 / 9 通过，隔离探针证明 `node:fs`
本身可用——缺陷在该测试文件内部。未定位，未修，**不属于吸收责任**。

### E. 已修正的失效门禁认知

`npx vue-tsc -b --force` 对**缺失的 `.vue` 文件是盲的**，因为 `packages/client/src/env.d.ts:5` 有
`declare module '*.vue'`。基座迁移时 70 个 fork 独有文件被静默丢弃，`vue-tsc` 报 0 错误，是
`npx vite build` 的 `UNLOADABLE_DEPENDENCY` 才暴露出来。**`vite build` 是必跑门禁**。
