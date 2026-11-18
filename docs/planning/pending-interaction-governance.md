# 待办交互治理（clarify / approval）实施方案

状态：已定稿待实施，2026-10-05。
范围：**全部三种载体** —— 单聊会话（`session`）、群聊房间（`room`）、移动端设备通道（`device`）。桌面端明确不在范围内。

## 一、根因

`clarify` 是全系统唯一一个**没有持久化、没有快照、没有对账**的交互状态。

对照已有的两项，它们都是齐全的：

| 状态 | 持久化 | 快照对账 |
| --- | --- | --- |
| 任务计划 | `task_plans` 表 | 有 |
| 运行中会话 | `sessionMap` | `working-sessions` |
| **待办交互** | 无（纯内存闭包） | **无** |

待办只活在 `ClarificationRuns.pending` 里，而它存的是**闭包**：

```ts
// clarification-runs.ts:9
type Pending = { contextId: string; sessionId: string; finish: (reason, response?) => void }
```

`finish` 是指向活进程的回调，**无法序列化**。状态不是一个值，而是一个还活着的函数。

### 生命周期被五个作用域切碎

| 作用域 | 承载者 | 谁改变它 |
| --- | --- | --- |
| 轮次 | `runMcpCredentials.issue()` | 每次开新轮 revoke 旧凭据；`isActive()` 随轮结束转假 |
| 会话 | `ClarificationRuns.pending`（会话级单例） | `beginTaskPlanRun:635` 每开新轮 `finishSession` 清空全部 |
| profile | 投递房间 `pending-interactions:${profile}` | 事件产生时的 profile |
| 账号 | `studio-account` 房间 | 未用于此用途 |
| 客户端 | `pendingClarifies` + `announcedKeys` | 组件挂载/重挂载 |

**取消发生在 A 作用域，通知发生在 B 作用域，两者没有共同读者。**

### 投递面共 8 条

| # | 通道 | 客户端是否接 |
| --- | --- | --- |
| 1 | `nsp.to('session:${id}')` | 打开该会话后入房 |
| 2 | `nsp.to('pending-interactions:${profile}')` | 连接时服务端代为入房（房间按发送方 profile） |
| 3 | 单播兜底 | 只在 `emitToSession:3369` 有；`emitExternalEvent:3088` **没有** |
| 4 | `session.activity` / `.snapshot` | **零监听** |
| 5 | resume 的 `data.events` 回放 | 只在 `switchSession:3233` 与重连 `:5178` |
| 6 | 群聊自有链路（`group-chat/agent-clients.ts`、`agent-relay.ts`） | 独立实现，客户端 `group-chat.ts:1255` 用**另一套 payload 结构**（`roomId` 而非 `session_id`） |
| 7 | `social-messages/session-push.ts` + 移动设备房间 | 独立实现 |
| 8 | `studio-account` 房间 | 已入房但此用途未使用 |

### 十个静默失败点（全部无日志）

1. `ClarificationRuns.active()` 409 —— context 过期 / 凭据撤销
2. `ClarificationRuns.request()` 409 —— "已有待办"（会话级单例）
3. `emitExternalEvent` 无单播兜底 → 房间空即丢
4. profile 错配（事件 profile ≠ 握手 profile）
5. `beginTaskPlanRun` 每轮取消待办，客户端可能收不到 resolved
6. 待办状态无快照、无轮询、无自愈
7. `abort.ts` 里 `clarify` 出现次数 = 0 → 完全无感知 → 死锁 → 8 秒看门狗
8. `GlobalPendingActions` 在 `route.meta.standaloneChat` 为真时不挂载（`App.vue:415-417`）
9. `announcedKeys` 提前标记 → 永久静音
10. notification 变体：`margin:-10px` 抵消规则 + `pointer-events` 未开

### 已确认的现象归因

- **跨会话第一次不弹** → 第 9 条（`announcedKeys` 毒化）
- **切回来后持久出现且点不动** → 第 5 条：旧待办被新轮判为 cancelled，但取消事件走事件产生时的 profile 房间，人在别处收不到 → 客户端条目永不清理
- **stop 无法确认** → 第 7 条：run 卡在 clarify 上，`finishTaskPlanRun` 只在终态事件触发，永不产生终态；abort 不调 `finishSession` → 8 秒看门狗 → 按钮死锁
- **default profile 两次都没到** → 第 1 或第 2 条，**三个候选机制无法区分，因为没有日志**（见 Phase 7）

## 二、原则

- TDD：**先写测试 → 确认转红 → 实现 → 转绿 → 变异校验**。不许先写实现再补测试。
- 每阶段独立可回滚。
- 每阶段结束必须 `vue-tsc -b` 与 `tsc --noEmit -p packages/server/tsconfig.json` 通过，且该阶段测试全绿，才进入下一阶段。

## 三、已定决策

| 项 | 决定 |
| --- | --- |
| 持久化 | **做**，新增 `pending_interactions` 表 |
| 房间级 profile 隔离 | **保留**，改为客户端多 profile 入房，不合并房间 |
| 数据库迁移 | 可以动 |
| 取消语义 | **方案 B：不顶掉**（精确语义见 D2） |
| **D1 覆盖范围** | **全部三种载体**：单聊 + 群聊 + 移动端 |
| **D2 取消语义** | **确认**：取消只针对"**所属那一轮已结束**"的待办，不针对"新一轮开始了"。待办活到「所属轮结束」或「超时 5 分钟」，两者取先 |
| **D3 快照轮询** | 复用 `WORKING_SNAPSHOT_POLL_MS`，**不新开定时器** |
| **D4 入房范围** | **全部可访问 profile** |
| **D5 桌面端** | **不在范围内**。原桌面端阶段删除，仅保留公开分享路由的安全回归断言 |

### D2 的实施要点（推演结论，必须遵守）

B 不能只是删掉 `beginTaskPlanRun:635` 那句全局清空。因为旧轮结束时凭据已被撤销（`isActive()` 转假），若卡片仍显示为「可作答」，点击后应答打到死掉的调用 —— **又会变成"点击无效"，正是要消灭的症状**。

正确做法：`beginTaskPlanRun:635` 删除全局清空，改由 `finishTaskPlanRun:673` 已有的 `finishSession(sessionId, contextId)` **按 contextId 精确结算**承担。

### D1 带来的结构性变化

- `pending_interactions` 表新增 `scope` 字段：`session` / `room` / `device`
- 唯一键由 `(session_id, interaction_id)` 改为 `(scope, owner_id, interaction_id)`，其中 `owner_id` 对 `session`/`device` 是 session_id，对 `room` 是 roomId
- `sockets/chat-run.ts:3407` 的 `if (source === 'group_chat') return` 提前返回**必须重新评估** —— 它当前恰好把群聊挡在 profile 房间之外
- 客户端 `groupChatStore`（`stores/hermes/group-chat.ts:1255`）有**独立**的 `pendingClarifies`/`pendingApprovals`，payload 结构不同（`roomId`），需单独接快照
- 移动端设备通道走 `mobileDeviceRoom`，与 `session`/`room` 都不同

## 四、施工阶段

行号基于实施前快照，**会随编辑漂移，实施时以锚点文本为准**。

### Phase 0 — 基线固化

跑 `tests/server/clarification-runs.test.ts`、`tests/server/clarifications-controller.test.ts`、`tests/client/global-pending-actions.test.ts`、`tests/client/pending-interaction-card.test.ts`，记录基线。

已知外部失败（另一条会话的在途改动，**不得当作本任务回归**）：`tests/client/compression-transcript-entry.test.ts`、`tests/client/chat-input-slash-menu.test.ts`。

### Phase 1 — 持久化（scope-aware）

**测试先行**：新建 `tests/server/pending-interactions-store.test.ts`

- `1.1` 建表后 `save` → `list` 取回完整字段（含 `question` / `choices` / `scope`）
- `1.2` 同 `(scope, owner_id, interaction_id)` 二次写入是 upsert，不产生两行
- `1.3` `resolve()` 后 `list` 默认不返回已终止项；`includeResolved` 时返回且 `status` / `resolved_reason` 正确
- `1.4` **三种 scope 各存一条**，同名 `interaction_id` 互不覆盖 —— **变异点：唯一键漏掉 `scope` 即转红**
- `1.5` 同 scope 下两个不同 `owner_id` 同名互不覆盖 —— **变异点：唯一键漏掉 `owner_id` 即转红**
- `1.6` 迁移幂等：连跑两次建表不报错

**实现**

- `schemas.ts:75` 仿 `TASK_PLANS_TABLE` / `:76` `TASK_PLANS_SCHEMA` 新增 `PENDING_INTERACTIONS_TABLE` / `PENDING_INTERACTIONS_SCHEMA`，复用 `:1287` 的 `CREATE TABLE ${quoteIdentifier(...)}` 路径
- 唯一索引仿 `:1769` `idx_task_plans_identity`，键 `(scope, owner_id, interaction_id)`
- 新建 `repositories/pending-interaction-store.ts`，接口与 `task-plan-store.ts` 同构

字段：`scope` / `owner_id` / `interaction_id` / `kind` / `status` / `profile` / `question` / `choices` / `run_id` / `context_id` / `deadline` / `created_at` / `resolved_at` / `resolved_reason`

**边界说明**：落库救的是**显示与对账**，不能救 agent 那个等待中的 MCP 调用。服务重启后凭据与调用栈都没了，恢复出来的行只能标记 `expired`。这恰好防止"幽灵卡片"永久挂在界面上。

### Phase 2 — 快照接口（scope-aware）

**测试先行**：新建 `tests/server/pending-interactions-snapshot.test.ts`

- `2.1` 无 pending 时返回 `[]`，不是 404
- `2.2` 只返回**调用者有权限的 profile** 的待办 —— **关键安全用例**：构造两个 profile，断言越权 profile 的数据不出现
- `2.3` 三种 scope 的条目都能返回，字段完整
- `2.4` 已终止项不返回
- `2.5` 进程内 `ClarificationRuns.pending` 与库不一致时，**以库为准**
- `2.6` 按 `scope` 过滤参数生效（请求只带 `session` 时不返回 `room`）

**实现**

- `routes/chat-run.ts:12` 旁新增 `GET /api/studio/chat-run/pending-interactions`
- `controllers/chat-run.ts` 仿 `workingSessions:73-94` 新增 handler，复用 `canAccessProfile`

### Phase 3 — 单聊：客户端入房 + 对账

**测试先行**：新建 `tests/client/pending-interactions-reconcile.test.ts`

- `3.1` 握手携带**全部可访问 profile**（D4），不是单个
- `3.2` 快照条目写入 `pendingClarifies`，本地多出的条目被清除 —— **变异点：只做并集不清除 → 幽灵卡片回归**
- `3.3` 快照失败时**不清空**本地条目（避免网络抖动抹掉正在显示的卡片）
- `3.4` 复用 `WORKING_SNAPSHOT_POLL_MS`，**不新增定时器**（断言定时器总数不变）—— **变异点：新开一个 interval 即转红**

**实现**

- `api/studio/chat.ts:861` 握手 `query: { profile }` → 改为携带 profile 列表
- `sockets/chat-run.ts:990` 的 `socket.join('pending-interactions:' + currentProfile())` → 逐个 `canAccessProfile` 校验后逐房间 join（**保留房间隔离，不合并房间**）
- `stores/hermes/chat.ts` 新增 `reconcilePendingInteractions(snapshot)`，挂在既有 `applyWorkingSessionsSnapshot` 同一轮询里

### Phase 4 — 方案 B：不顶掉（工作量最大、风险最高）

**测试先行**

扩 `tests/server/clarification-runs.test.ts`：

- `4.1` 同会话第二个 `request()` **成功**（当前 409）—— **变异点：把 `clarification-runs.ts:53` 的单例检查改回来即转红**
- `4.2` 两条待办各自独立 resolve，互不影响
- `4.3` 一条 `aborted`、另一条仍 `pending` —— **变异点：`finishSession` 按会话全清即转红**
- `4.4` **D2 核心用例**：新轮开始后，**属于已结束那一轮**的待办变 `expired`，而**属于仍活着那一轮**的待办保持 `pending` —— **变异点：改回 `beginTaskPlanRun:635` 的全局清空即转红**

新建 `tests/client/pending-clarify-multi.test.ts`：

- `4.5` 同会话两条待办**都**能进 store（当前 `Map<sessionId,...>` 只能存一条）—— **变异点：键仍用 sessionId 即转红**
- `4.6` `MessageList` 渲染两张卡片
- `4.7` 各自独立提交 / 清除

**实现**

- `clarification-runs.ts:53` 删除会话级单例 409
- `chat-run.ts:635` 删除全局清空；改由 `finishTaskPlanRun:673` 的 `finishSession(sessionId, contextId)` 按 contextId 精确结算
- `chat.ts:4223` `pendingClarifies` 键由 `sid` 改 `sid:clarifyId`；`:1709` `activePendingClarify` 改列表；`MessageList` 改多卡片渲染

**顺序约束**：`4.7` 与 Phase 8 的 `announcedKeys` 改动有耦合，先做 Phase 8 会互相污染 —— **顺序不可颠倒**。

### Phase 5 — abort 接管

**测试先行**：新建 `tests/server/clarify-abort-decoupling.test.ts`

- `5.1` abort 后该会话所有 pending 变 `aborted`，并发出一条 `clarify.resolved`
- `5.2` abort 后**仍能**发出 `abort.completed`（当前死锁场景）
- `5.3` **变异点：去掉 abort 里的 `finishSession` → `5.2` 转红**
- `5.4` `emitExternalEvent` 补单播兜底后，session 房间为空时事件仍达

**实现**

- `abort.ts`（当前 `clarify` 出现 0 次）在终止前插入 `clarificationRuns.finishSession(sessionId, undefined, 'aborted')` —— 需先给 `finishSession` 加 reason 参数
- `chat-run.ts:3088` `emitExternalEvent` 补上 `emitToSession:3369` 已有的单播兜底
- 客户端 `ABORT_WATCHDOG_MS`（`chat.ts:562`）8s → 20s，且存在 pending 时不判失败

### Phase 6 — 消除双投递

**测试先行**：扩 `tests/client/global-pending-actions.test.ts`

- `6.1` 同一 clarify 事件只导致**一次** store 写入 —— **变异点：恢复无条件 `peerUserMessageHandlers` 广播即转红**
- `6.2` 该 sid 无注册 handler 时仍能落库（兜底不能丢）

**实现**：`api/studio/chat.ts:626/637/662/673` 的无条件分发改为"仅当 `sessionEventHandlers` 无该 sid 时"。

### Phase 7 — 静默失败开口

**测试先行**：扩 `tests/server/clarification-runs.test.ts`

- `7.1` context 过期时抛出**可区分**错误码（非笼统 409）
- `7.2` 拒绝路径产生日志（spy 断言被调用，且含 `contextId` / `sessionId`）
- `7.3` **变异点：去掉日志即转红**

**实现**：`clarification-runs.ts:44-47`（`active()`）与 `:53` 加日志；`ClarificationError` 增 `code` 字段。

### Phase 8 — 前端收口

**测试先行**：扩 `tests/client/pending-interaction-card.test.ts` + `tests/e2e/clarify-option-touch-target.spec.ts`

- `8.1` 三个 variant 同形（无 `margin:-10px` 抵消）
- `8.2` notification 卡片按钮**可点击**（真实浏览器断言）
- `8.3` `announcedKeys` 不再提前标记：未播报的 key 在就绪后仍会播报 —— **变异点：改回 `add` 在 `if` 之前即转红**

**实现**：删 `margin:-10px; width:calc(100% + 20px)`；`.n-notification:has(...)` 外壳透明化 + `pointer-events: auto`；`GlobalPendingActions.vue:394-409` 调整标记时机。

### Phase 9 — 群聊纳入（D1）

**测试先行**：新建 `tests/server/group-clarify-pending.test.ts` + `tests/client/group-pending-reconcile.test.ts`

- `9.1` 群聊房间的 clarify 落库时 `scope='room'`、`owner_id=roomId`
- `9.2` 快照按 `scope='room'` 过滤能取回，且 payload 使用 `roomId` 字段（不是 `session_id`）
- `9.3` 客户端 `groupChatStore` 的 `pendingClarifies` 被快照对账填充与清除
- `9.4` **变异点：`chat-run.ts:3407` 的 `if (source === 'group_chat') return` 保持原样 → `9.2` 转红**

**实现**

- 重新评估 `sockets/chat-run.ts:3407` 的群聊提前返回
- 群聊来源的待办以 `scope='room'` 落库
- `stores/hermes/group-chat.ts:1255` 接快照对账

### Phase 10 — 移动端设备通道纳入（D1）

**测试先行**：新建 `tests/server/mobile-pending-channel.test.ts`

- `10.1` 设备通道的待办以 `scope='device'` 落库
- `10.2` 设备房间能收到事件（当前 `mobileDeviceRoom` 只覆盖部分事件类型）
- `10.3` 客户端在移动视口下快照对账正常（Playwright 412×900）
- `10.4` **变异点：落库时漏掉 `scope='device'` 即转红**

**实现**

- `emitMobileCalendarEvent:3355` 一带的设备投递扩展覆盖面
- 设备通道待办以 `scope='device'` 落库

**残余不确定性**：若移动端是**本仓库之外**的独立原生 App，其配合改动不在我可见范围内。本仓库能保证的是服务端设备通道携带完整载荷、以及 Web 客户端在移动视口下的行为。**开工前需你确认移动端载体是哪个。**

### Phase 11 — 公开分享路由安全回归（原桌面端阶段，D5）

桌面端不在范围内，但**公开分享路由必须仍然不挂载全局待办层** —— 防止后续重构顺手放开。

**测试先行**：新建 `tests/client/standalone-chat-meta.test.ts`

- `11.1` `share.groupChat` / `groupChat.link` **不**挂载 `GlobalPendingActions`
- `11.2` `hermes.session` / `hermes.chat` **要**挂载

**实现**：仅补断言，`App.vue:415-417` 逻辑不动（`/desktop-chat/:sessionId` 不处理）。

## 五、端到端验收

新建 `tests/e2e/pending-interaction-cross-session.spec.ts`

- `E1` 会话 A 发出 clarify，切到会话 B，通知出现且**可点击并提交成功**
- `E2` 提交后切回 A，卡片已消失（对账生效）
- `E3` 服务端单方面取消后，前端不再显示可答卡片
- `E4` 群聊房间发出 clarify，切到单聊后仍能收到并可提交（跨 scope）

## 六、风险

1. **Phase 4 是唯一触及核心类型结构的阶段**。`pendingClarifies` 改键牵动 `activePendingClarify`、`MessageList`、`GroupChatPanel`、`GlobalPendingActions` 四处。建议 1–3 全绿稳定后再动，出问题才分得清是地基还是改键。
2. **Phase 3 是安全边界变更**（保留房间隔离，但会 join 多个房间）。`2.2` 与 `11.1` 两个越权/安全用例必须先在快照接口层跑通，再放开入房。
3. **D1=全部显著放大工作量（约 2.5×）**。群聊有独立的客户端 store 和**不同的 payload 结构**（`roomId` vs `session_id`），不是同一套代码改个参数。建议 Phase 9/10 各自独立验收，不与前面混在一起测。
4. **Phase 9 与 Phase 4 有隐含耦合**：`pendingClarifies` 改键若只改单聊那一份，群聊那份会留下不一致。**Phase 4 收尾时必须检查 `group-chat.ts` 是否也需要同步改键**，否则 Phase 9 会踩坑。
5. **Phase 8 与 Phase 4 顺序不可颠倒**（见 Phase 4 末尾）。

## 七、未决事项

D1–D5 已全部确认，见第三节。

剩余一项待验证（**不阻塞开工**，但 Phase 10 开工前必须确认）：

- **移动端载体是哪个**：本仓库 `packages/` 下无 mobile 包，`packages/desktop` 是 0 处 clarify 引用。若移动端为本仓库之外的原生 App，Phase 10 的范围需要重新界定。

## 八、实施进度（截至 2026-10-06）

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| Phase 0 基线 | 完成 | 基线测试 62/62 |
| Phase 1 持久化 | 完成 | `pending-interactions-store.test.ts` 8 例 + 变异全红 |
| Phase 2 快照接口 | 完成 | `pending-interactions-snapshot.test.ts` 6 例 |
| Phase 3 单聊入房 + 对账 | 完成 | `pending-interactions-reconcile.test.ts` 5 例 |
| Phase 4 方案 B 不顶掉 | 完成 | `pending-clarify-multi.test.ts` 9 例、`MessageList` 多卡 |
| Phase 5 abort 接管 | 完成 | 服务端 5 文件 39 例；`abort-watchdog-clarify.test.ts` 5 例；8/8 变异红 |
| Phase 6 消除双投递 | 完成 | `pending-interaction-delivery.test.ts` 4 例；5/5 变异红 |
| Phase 7 静默失败开口 | 完成 | `clarification-runs.test.ts` 19 例；7/7 变异红 |
| Phase 8 前端收口 | 完成 | `global-pending-actions.test.ts` 36 例；`pending-interactions-wiring.test.ts` 8 例；e2e 真实浏览器断言 |
| **Phase 9 群聊纳入** | **服务端一半完成** | 见下 |
| Phase 10 设备通道 | **未开工（被阻塞）** | 需先确认移动端载体 |
| Phase 11 公开分享路由 | 完成 | `standalone-chat-meta.test.ts` 3 例；4/4 变异红 |

### Phase 9 已完成的部分

- 新增 `services/group-chat/pending-interactions.ts`：房间待办以 `scope='room'`、`owner_id=<roomId>` 落库，profile 取 `storage.getRoom(roomId)?.summaryProfile`。
- `sockets/group-chat.ts` 接线：提问时 `persistRoomClarify`；结算集中在 `takePendingClarifyRoute`（**所有**移除路径的唯一汇聚点），并区分 `response` / `dismissed` / `expired` / `aborted` / `cancelled`。
- 测试 `tests/server/group-clarify-pending.test.ts` 9 例；**9/9 变异红**。
- 注：`GroupChatServer` 构造即起 socket.io + 存储，无法单测，故接线用源码级断言固定（沿用仓库既有做法）。

### Phase 9 仍缺（不阻塞单聊范围内的任何验收）

- `9.2` / `9.4`：反复评估 `sockets/chat-run.ts` 的 `if (source === 'group_chat') return` —— 它当前把群聊挡在 `pending-interactions:${profile}` 之外。
- `9.3`：`stores/hermes/group-chat.ts` 接快照对账（该 store 已有 `${roomId}:${clarifyId}` 复合键与入房 ack，缺的是持久化快照那一路）。
- 跨 scope 提交（E4）：卡片需按 scope 把作答投给群聊 socket（`roomId`）而非单聊 socket（`session_id`）。

### 实施中新发现并修复的缺陷（不在原计划内）

**服务端已结算的待办，卡片不消失。** agent-run 路径下发 `clarify.resolved { resolved: false, reason: 'cancelled' | 'aborted' | 'dismissed' }`（见 `handle-ekko-agent-run.ts` 的 `onResolved`），而 `stores/hermes/chat.ts` 的 `clearPendingClarify` 只认**过期形态**的 reason。于是其余结算一律被忽略：服务端已放手，卡片却留在界面上“看起来可作答、点了没反应”——正是原始症状 1/2。

- 修法：新增 `isPendingInteractionSettledReason`（`utils/pending-interaction.ts`），任何结算 reason 都清卡；**被拒绝的提交**（只有 `error`、无 reason）仍保留卡片以便重试。
- 覆盖：`pending-clarify-multi.test.ts` 9 例、5/5 变异红；全量跑出并修正了一处自伤回归（曾漏掉 `error`/`stale` 对“过期提示”的判定，`chat-store-error-handling.test.ts` 抓到）。

### 端到端验收现状

### Phase 9 客户端一半（已完成）

**关键发现：跨 scope 的客户端链路早已实现，缺的只是"房间提示能送达不在房间里的你"。**

- `GlobalPendingActions.pendingActions()` 早就把 `groupChatStore` 的待办合进全局待办，kind 是 `group-clarify` / `group-approval`，key 用 `roomId`，标题用 `roomTitle`；`submitClarify` / `submitApproval` 也早就按 kind 分流到 `groupChatStore.respondClarifyFor(roomId, …)`。
- `chat-run.ts` 的 `applyPendingInteractionsSnapshot` 注释明确写着"Carriers this store does not own are left to their own store"——**各 store 按 scope 分工**，这是既有约定。
- 所以 `9.3` = 群聊 store 自己对账 `scope='room'`：新增 `applyPendingInteractionsSnapshot` / `reconcilePendingInteractions(Quietly)`，并复用 socket 已有的 `load_pending_approvals`（**服务端已按 `canSocketManageRoom` 过滤**，且覆盖该用户可管理的**全部**房间）——之前这个列表被直接丢弃，这正是"人在单聊里收不到房间提问"的原因。

**关于 `9.2` / `9.4` 的反复评估（结论：该早期返回必须保留）**

`9.2` 原定的实现是放开 `chat-run.ts` 的 `if (source === 'group_chat') return`。结论是**不能这么做**：那条路径的载荷是 `session_id` 形态（群聊 agent session），放开后同一个提问会被渲染成两张卡，**只有其中一张可作答**——正好复现刚修掉的"看起来能答、点了没反应"。真正正确的送达路径是群聊 socket 的 `load_pending_approvals`（按房间门禁、覆盖全部可管理房间）。故 `9.2` 的目标已由该路径达成，`9.4` 的变异点改由两条测试固定：`group-clarify-pending.test.ts` 里断言 `handleClarifyRequested` 按 `roomId` 播报（不是 `session_id`），且 `emitPendingInteraction` 仍然对 `group_chat` 提前返回。

### Phase 10（已完成，范围被用户答复重定义）

用户答复：**移动端 = 手机浏览器打开 Web UI**。故原计划中的"独立设备通道（`scope='device'`）"**不再成立**——手机浏览器走的仍是既有 session/room 载体。Phase 10 因此只剩一件事：**手机视口下的卡片必须完整可见、控件必须可点**。

- 新增 e2e「the whole card fits a phone viewport once it settles」：412px 视口下断言卡片左边界 ≥ 0、右边界 ≤ 视口，且卡片内按钮同样落在视口内。
- **纠正一处此前的误判**：先前记录的"toaster 在 412px 视口溢出（卡片 85→423 / 通知 68→448）"是**采样到了入场动画中途**。等到动画结束后实测：卡片 `33→371`、通知 `16→396`、视口 `412`——**完全在屏内**，不存在真实溢出。入场动画本身从屏幕右侧滑入是预期行为。
- 移动端宽度已被两层结构性约束保护：`@media (max-width: 600px)` 把通知收到 `calc(100vw - 24px)`，另有 380px 的 `max-width`。**尝试过用负 margin 与宽度变异去触发该 e2e，均未转红**——说明移动溢出已被结构性防止，该断言是回归保险而非对某个具体样式的钉子。



`tests/e2e/pending-interaction-cross-session.spec.ts`：跨会话待办到达且可作答；服务端结算后不再可作答。E2 的“真实会话切换”与 E4 的跨 scope 待 Phase 9 投递那一半。
