# reasoning_effort 自动匹配机制

客户端可选的推理档位往往比 provider 实际接受的范围更宽。发送一个不支持的值会让**整轮请求失败**，
用户看到的是「我选了 max 然后就用不了了」。

本文记录 hermes-studio 的完整实现，可直接移植到其它 LLM UX 项目。

## 1. 问题

UI 提供 `none / minimal / low / medium / high / xhigh / max` 七档，但：

- 多数 provider 只接受其中一部分，`xhigh` / `max` 是厂商扩展
- **Anthropic 根本没有 effort 枚举**，它用 `thinking.budget_tokens`（token 预算）
- 自建 / 新接入的 OpenAI 兼容端点可能只认 4 个可移植值

失败形式：`reasoning_effort_not_supported`，出现在嵌套字段里
（`{error:{message}}` / `{detail}` / `{data:{...}}`），不是一个统一的错误码。

## 2. 参考：LiteLLM 的做法

来源：`BerriAI/litellm`

| 文件 | 作用 |
|---|---|
| `litellm/router_utils/reasoning_effort_capability.py` | 能力解析与分级语义 |
| `litellm/llms/openai/chat/gpt_5_transformation.py` | 请求路径的档位门控 |
| `litellm/llms/anthropic/chat/transformation.py` | Anthropic 的 thinking budget 分桶 |
| `litellm/exceptions.py` (`UnsupportedParamsError`) | 显式声明不支持的语义 |

**关键结论**（逐条来自源码注释，不是推测）：

1. **分级不对称**：`medium`/`high` 对推理模型是无条件支持；`minimal`/`low` 是 opt-out；
   `xhigh`/`max` 是 opt-in。**缺失信号不等于支持**。
2. **未知即未知**：能力表查不到的部署解析为 `None`，不套用默认值。原文理由——
   854 条记录里 689 条没有标志位，套默认值会「宣传那些 provider 实际拒绝的档位」。
3. **opt-in 是刻意权衡**：原文明确说，缺标志位「只会损失建议性元数据，而不会导致请求被拒」。
4. **不是所有 provider 用枚举**：Anthropic 走 `thinking.budget_tokens`，用共享常量
   （`DEFAULT_REASONING_EFFORT_*_THINKING_BUDGET`）分桶回档位。
5. **LiteLLM 不做错误驱动的重试降级**——它是声明式查询，请求前就知道答案。

## 3. 本项目的实现

### 三层求交

```
Layer 1  static    内置 provider+model → 支持档位（来自公开数据）
Layer 2  observed  运行时成功/失败累积，带 6h TTL，落 SQLite
Layer 3  family    未知 model 时按 provider 家族保守推断
```

**任一层说否即否。持久化行只能收窄静态表，绝不放宽。**

### 失败关闭（fail-closed）

未知 provider → **不发 effort 参数**。这与「透传」相反，因为透传的正是那个会失败的请求。
代价是自建 provider 首次使用会失去 effort 控制，直到第一次成功调用后由观测层补上。

### 两条路径

| 路径 | provider 调用归属 | 策略 |
|---|---|---|
| Coding Agent 代理 | 我们自己的 gateway | 请求前解析 + 报错后降一档重试并记住 |
| Hermes 聊天 | **外部 Agent 子进程** | 只能请求前解析 + 报错后记住（无法原地重试） |

聊天路径的两半缺一不可——第一次实现只做了请求前解析，因为没有东西填表，结果整个改动是空操作。

### 文件

| 文件 | 职责 |
|---|---|
| `packages/server/src/lib/reasoning-effort.ts` | 档位阶梯、`pickSupported`、`stepDown`、错误识别（含嵌套展开） |
| `packages/server/src/lib/reasoning-effort-capabilities.ts` | 静态能力表 + 家族推断 |
| `packages/server/src/lib/reasoning-effort-resolve.ts` | 三层求交、观测层、防抖落盘、重试包装 |
| `packages/server/src/modules/studio/repositories/reasoning-effort-capability-store.ts` | SQLite 持久化 |
| `packages/server/src/modules/coding-agents/protocol/gateway.ts` | 代理路径接入点（单一出口） |
| `packages/server/src/modules/studio/sockets/chat-run.ts` | 聊天路径接入点 |

### 观察点选择

代理路径只在 `AgentRunGateway.post()` 接入——所有 Coding Agent provider 请求都经过这一个出口，
适配器只做 payload 翻译，逐个改既漏又脆。`model` 从 `request.body.model` 兜底，
避免改十来个调用点。

## 4. 移植指南

最小可用集是三个文件 + 一个 store，约 400 行。移植时按此顺序：

1. **先做静态表**，它独立生效，不依赖任何运行时反馈。
   务必照抄分级语义（无条件 / opt-out / opt-in），不要统一当成 opt-in——
   那会让绝大多数 provider 丢掉 medium/high。

2. **再决定未知策略**。fail-closed 更安全；如果你的场景 provider 高度定制、
   且能接受首轮失败，可以改成「透传 + 失败后记住」。

3. **持久化用缓存表，不是权限表**。写入防抖、`unref()`、失败返回 null 降级，
   三者缺一就会在请求路径上引入故障。本项目的 `database()` 最初就在
   `try` 外建表，被「关闭数据库」测试直接抓到。

4. **错误识别必须递归展开**。`String(errObj)` 得到 `[object Object]`，
   这是本项目测试抓到的真实 bug。

5. **不可重试的路径要做两半**：请求前解析 + 报错后记忆。缺后半段整个机制不生效。

## 5. 可观测性

每次调整一行结构化日志，字段固定，便于排查「为什么我的 max 变成了 high」：

```
[reasoning-effort] max -> high provider=deepseek model=deepseek-v4 reason=family capability table tops out below max
```

用户侧**不暴露**调整结果——静默降级优于报错，档位变化不是用户需要处理的事。

## 6. 本期未做

- **Anthropic `thinking_budget` 分桶**：需要 `budget_tokens ↔ effort` 换算表，
  当前对 Anthropic 一律不发 effort。
- **静态表覆盖度**：常见 provider 已覆盖；自建中转站依赖观测层学习。
  可考虑从 LiteLLM 的 `model_prices_and_context_window.json` 生成。

## 7. 验证

| 项 | 结果 |
|---|---|
| vue-tsc / server tsc | 0 |
| build | 通过 |
| client | 286 文件 / 1947 用例全绿 |
| server | 20 条，与既有基线一致 |
| 新增测试 | 40 项（解析与能力表 20、gateway 9、聊天路径 5、持久化 6） |
