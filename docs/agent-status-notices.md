# Agent 运行中状态行（会话里那些「气泡」）

本文记录 agent 在**一轮 run 存活期间**发到会话里的状态行 —— 它们的来源、渲染规则、
以及为什么它们和普通消息不一样。

写这份文档的原因：这套东西出过三次同型问题（旧的琥珀气泡、跨会话提醒被裁、
状态行被误判成失败），每次都在同一个位置反复踩。

---

## 1. 它们是什么

**不是消息，是状态行。** 三个关键差异：

| | 普通消息 | 状态行 |
|---|---|---|
| 落盘 | 是 | **否** |
| 刷新后 | 还在 | **消失** |
| 同时存在几条 | 多条 | **一条**（原地替换） |
| 进入模型上下文 | 是 | **否** |

实测证据（不要靠读代码推断，直接查库）：

```bash
sqlite3 ~/.hermes/hermes-web-ui/hermes-web-ui.db \
  "SELECT role, COUNT(*) FROM messages GROUP BY role;"
# assistant / tool / user / command / session_meta / error —— 没有 system
```

`role='system'` 的行数是 **0**。这类东西从来不落盘。

客户端侧的清理点：`packages/client/src/stores/hermes/chat.ts` 的
`clearAgentEventMessages()` —— run 一结束就把非错误的状态行从记录里删掉。

---

## 2. 链路

```
agent 侧  _emit_status(msg)          → status_callback("lifecycle", msg)
          _emit_warning(msg)         → status_callback("warn", msg)
   ↓
bridge    bridge_pool.py:1227
          {"event": "status", "kind": kind, "text": text}
   ↓
服务端    handle-bridge-run.ts:1770  evType === 'status'
          { ...ev, event: 'agent.event', run_id }
   ↓
客户端    chat.ts handleAgentEvent()  → addAgentError / 状态行
```

**`kind` 会一路传到前端**，但只有两个有意义的取值：

- `lifecycle` —— 进度，也是**阻塞等待**
- `warn` —— agent 自己标为降级的路径

### 关键限制：agent 分不开「阻塞」和「进度」

两者**都是 `lifecycle`**：

```python
# agent/turn_facade_lease.py —— 等租约
agent._emit_status("⏳ Another Hermes process is using this session; ...")
# agent/conversation_compression.py —— 压缩进度
agent._emit_status("📦 Preflight compression: ...")
```

所以前端只能用**窄的机器特征**区分（见第 3 节）。这是已知的妥协，不是疏忽。

---

## 3. 渲染规则

只有两种形状。**第三种（旧的琥珀左条气泡）已删除，不要复活。**

| 判据 | 样式类 | 观感 |
|---|---|---|
| 失败（`BRIDGE_FAILURE_PATTERNS`） | `.agent-error` | 红 |
| `kind === 'warn'` | `.agent-error` | 红 |
| 阻塞特征（`/^\s*⏳/`） | `.agent-error` | 红 |
| 其余 `system` 行（无 `systemType`） | `.notice` | 灰（与 `.command` / `.compression` 共用那套中性卡） |
| 普通回复 | — | 中性 |

判定顺序在 `chat.ts` 的 `handleAgentEvent()`；类名在 `MessageItem.vue` 的气泡 `:class`。

### 实测文本 → 落在哪一档

| agent 原文 | 触发时机 | 样式 |
|---|---|---|
| `⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn...` | 会话被另一个进程占着 | 红 |
| `⏳ Still waiting for the other Hermes process on this session (12s)...` | 同上，秒数递增 | 红 |
| `⏳ Another Hermes process kept this session busy too long. Your message was not processed.` | 等待超时（带 `failure_reason: session_busy`，走失败路径） | 红 |
| `Session is free; loading the latest transcript...` | 拿到租约后 | 灰 |
| `🗜️ Compacting context — summarizing earlier conversation so I can continue...` | 手动/自动压缩 | 灰 |
| `📦 Preflight compression: ~120,000 tokens >= 100,000 threshold. This may take a moment.` | 接近上限 | 灰 |
| `📦 Pre-API compression: ~123,456 tokens near the context/output limit. ...` | 接近上限 | 灰 |
| `💤 Resumed after 3600s idle — compacting ~120,000 tokens before continuing.` | 闲置后恢复 | 灰 |
| `🗜️ Compressed 1,234 → 567 messages, retrying...` | 压缩重试 | 灰 |
| `🧠 <Provider> — recalled 3 memories` | 记忆召回 | 灰 |
| `⚠ compression model unavailable` 等 | `_emit_warning`，即 `kind='warn'` | 红 |

### 只有桥接会话显示

`chat.ts` 里对 coding-agent 会话直接丢弃：

```js
if (evt.source === 'coding_agent' && evt.kind === 'status') return
```

Ekko / coding-agent 会话有自己的活动轨（`kind: 'status'` 的 activity entry），
不走这条路径。

---

## 4. 改动这套东西时必须遵守

这些不是建议，是前面三次事故换来的：

1. **不要按文本宽泛分类。** 历史事故：把 `"Error handling in the parser looks correct"`
   和 `"The failed test was flaky"` 涂红 —— 因为按文本猜。
   本仓库犯过第二次：给阻塞特征加了 `/waiting for it to finish/i`，
   结果把普通回复 `"I was waiting for it to finish, then the parser looked correct"`
   判成了阻塞。**任何按文本的分类，必须同时写「必须匹配」和「必须不匹配」两组用例，
   反例要把关键词放进自然句子里。**

2. **不要复活琥珀气泡。** 它是「全应用只有这一处在用的第三种颜色」。
   要表达新含义就复用一个已有的形状，或明确新增——但不要留一条没人用的规则。

3. **退役一个样式，要搜它的「取值」而不是名字。** 注释里写着
   `this fork retired the amber system bubble`，而 `.message-bubble &.system`
   里的 `$warning` 还在生效。**注释会撒谎。**

4. **`hasLocalRunEvidence` / 气泡样式这类「谁负责」的问题，要能对上触发点。**
   轮询守卫漏掉已附加的流 = 永久泄漏。

---

## 5. 怎么验证

### 5.1 看样式（不需要触发任何东西）

```bash
node scripts/preview-agent-notices.mjs
```

产出一份 HTML，**直接引用构建产物里的 CSS**，class 与 scope 属性（`data-v-…`）
和线上一致。用浏览器打开即可看到红/灰两档的实际观感。

> 前提：先 `BASE_URL=/hermes/ npm run build`，脚本要读 `dist/client/assets/css/`。

### 5.2 看事件（确定有没有到达前端）

这是**零触发、最可靠**的办法：

1. F12 → **Network → WS** → 点那个 socket → **Messages**
2. 筛选 `agent.event`

每一条状态长这样：

```json
{"event":"agent.event","kind":"lifecycle","text":"📦 Preflight compression: ...","run_id":"..."}
```

`kind` 是 `lifecycle` 还是 `warn` 一眼可辨。

### 5.3 触发（想看真实气泡时）

**进度（灰）** —— 最容易，在桥接会话里发送：

```
/compact
```

（`/compress` 同样合法。）

**阻塞（红）** —— 需要两个进程抢同一个会话，
且**看哪边是等待方，⏳ 就出现在哪边**：

- 手机和电脑各开同一个会话
- 先从一个发慢请求
- 趁它还在跑，从另一个发消息
- **后发的那个**会显示 `⏳ ...`

> 用 CLI 当第二进程（`hermes chat --resume <id> -z "..."`）理论上可行，但
> **Studio 的 session id 与 agent 侧的对应关系未确认**
> （`sessions.agent_session_id` 字段实测为空），所以不要直接照抄这条命令。

---

## 6. 已知取舍

| 取舍 | 说明 |
|---|---|
| 阻塞族靠 `⏳` 字形识别 | agent 不给结构信号。上游若换掉这个字形，这族会**降级成灰色**（而不是误报红色）—— 软退化 |
| `kind='warn'` 一律红 | 若出现良性的 warn，把原文加进白名单即可 |
| warning 类可能被配置抑制 | agent 侧有 `suppress_warning_notifications`，只影响 `warn`，不影响 `lifecycle` |

---

## 7. 代码位置

| 关注点 | 文件 |
|---|---|
| 分类（失败/阻塞/警告 → 错误行） | `packages/client/src/stores/hermes/chat.ts` `handleAgentEvent` |
| 特征清单 | 同文件 `BRIDGE_FAILURE_PATTERNS` / `BRIDGE_BLOCKED_PATTERNS` |
| 类名判定 | `packages/client/src/components/hermes/chat/MessageItem.vue` |
| 灰卡样式（与 command/compression 共用） | 同文件 `&.notice` |
| 服务端包装 | `packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts` |
| bridge 侧事件构造 | `packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py` |
| 守卫（结构） | `tests/client/chat-error-bubble-style.test.ts` |
| 守卫（渲染行为） | `tests/client/message-notice-bubble.test.ts` |
| 守卫（分类 + 反例） | `tests/client/error-text-classifier.test.ts` |

---

## 8. 相关提交

```
1d601de32  fix(chat): split the agent's mid-run lines into blocked and progress
a90a47b1e  fix(chat): retire the third bubble style instead of announcing it
```

纪律条目见 `docs/fork-customization-discipline.md` 的 5.9（「已在注释里宣布退役」不等于已退役）
与 5.10（上游不给信号时，按文本分类必须先过反例）。
