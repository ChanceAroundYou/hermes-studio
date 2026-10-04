# Upstream merge ledger

本 fork 相对上游 `origin/main`（0.7.27）的合并台账。
`origin` = EKKOLearnAI/hermes-web-ui，共同祖先 `b0555a0b3`（0.7.23）。

## 状态：已全部追平

上游 83 个 commit 全部处理完毕。其中 `1ecc1115b` 与 `c756486f9` 的内容已在本 fork
（前者因标题微调、后者因被同 PR 的前一个 commit 覆盖，自动比对会漏判）。

| 上游 commit | 本地 commit | 冲突处理 |
|---|---|---|
| `458561cdb` #3176 桌面更新进度 | `dd62b58a1` | 6 个测试构建文件取 ours（`a485b57d6` 是更新版） |
| `809e76ace` #3191 侧栏账户菜单 | `246eb2999` | 方案 A：保留 fork 内嵌的 Profile/模型/语言/主题四件控件 |
| `c19521d99` #3232 统一布局 | `1c8692c07` + `176706176` | 31 个冲突文件取上游，会话头部叠回 ours；共用卡片接回 |
| `0bd712638` #3234 / `6aedb931b` #3235 窗口控件 | `526747541` / `fad153ce0` | 零冲突 |
| `a1304fa1d` #3236 桌面主题 | `a3b80b046` | tests/e2e/theme.spec.ts 两侧用例并存 |
| `200f0eec8` #3237 / `ef9409601` #3255 版本 | `bbb0b8e6c` / `9423cd9d5` | 0.7.26 -> 0.7.27 |
| `94d206e77` #3241 run 用量与速度 | `6fd4d31da` | 零冲突 |
| `96469c573` #3246 用量归因 | `c55b89c1a` | chat.ts import 冲突：保留 ours 全部符号 + 补 onRunUsageUpdated |
| `972030895` #3204 上下文溢出恢复 | `479619ff7` | 零冲突 |
| `1ecc1115b` #3242 跨 profile 读取 | `1916c3541` | 保留 ours 的 requireSocketSessionAccess（含 state.db fallback） |
| `fe6754b00` #3248 组聊气泡用量 | `335d8a3c1` | 零冲突 |
| `3a2475438` #3247 抽屉与工作区选择器 | `e8d3e81d8` | 取上游 UI 重构，保留 ours 收藏快捷行与长按手势 |
| `4b7220370` #3253 用量计价选择 | `e62e81864` | 零冲突 |
| `f918e0fb4` #3244 Grok roles | `b596c63bb` | 零冲突 |
| `2c27ee492` #3262 设备连接图标 | `54f029ecc` | 零冲突 |
| `8564948c5` #3260 Claude stdout 排空 | `ed2aac251` | 零冲突 |
| `354894f81` #3257 API relay 合作页 | `d74662e37` | `AppConnectionsPanel.vue` 冲突：保留 `${getBaseUrlValue()}/logo.png` |
| 本轮图标路径补前缀 | `8be2648ba` / `ae65a0215` | #3257 又引入 5 处裸路径，同批修掉 |
| （配套测试修复） | `25741c477` | #3246 新增 socket 订阅，6 个 vi.mock 需补 onRunUsageUpdated |

## fork 保留下来的定制（合并时逐项确认）

**权威清单是 `tests/client/fork-customizations.test.ts`（断言数会随定制增减，故意不写死），
纪律与事故记录见 `docs/fork-customization-discipline.md`。**
下表是人读的摘要；合并收尾时跑清单测试，不要只对这张表。

| 定制 | 位置 | 合并策略 |
|---|---|---|
| 会话头部 header-identity + workspace-badge | ChatPanel.vue | 叠在上游 PageHeader / HeaderSidebarToggle 基底上 |
| 收藏走 workspacePreferences | FolderPicker.vue | 快捷行整块保留，上游重构只用于目录树 |
| 触屏长按 = 上下文菜单 | FolderPicker.vue | 上游删了手势，绑回行 wrapper |
| 共用 PendingInteractionCard | MessageList + GroupChatPanel | 上游拆成两段内联面板，接回共用卡片 |
| /hermes/ 子路径资源 | index.html + 头像 getBaseUrlValue() | 全程保留 |
| 并行多 profile | chat-run.ts | 不引入上游更弱的 requireSocketSessionReadAccess |
| 移动端 Enter 换行 | ChatInput.vue | 上游删了分支，补回 |
| 历史视图 error 显示为 system | HistoryView.vue | 保留 |
| 统一红泡 + 原地保留 + 不进上下文 | chat.ts + MessageItem.vue + session-store.ts | 保留 |
| 后台委派上报 + 证据上限 | chat-run.ts + chat.ts | 保留；删掉会让侧栏环永远转 |
| 完成信号单一出口 settleSessionFinished | chat.ts | 保留；复活第二个出口会重复通知 |
| 工作态 3s 独立轮询 | chat.ts | 保留；改走 refreshSessionListOnly 会变成 DB 读 |

## 有意移除的上游功能（cherry-pick 时勿带回）

| 功能 | 上游来源 | 说明 |
|---|---|---|
| API 中转（侧边栏「饲料」入口、页面、用量卡片、`relay-logo.png`、`/api/hermes/api-relay/usage`） | #3257 / #1374 | 整条链路已删：前端 4 文件 + 路由 + 两个侧边栏入口，服务端 3 文件 + 端点，11 语言文案，server/e2e 测试 |

zh侧边栏的「饲料」文案来自上游 #1374，不是本 fork 所加。清单里的
`deliberately removed upstream features` 分组专门守这条：cherry-pick #3257 会把
整个功能静默带回，而页面能编译、路由能解析、导航能渲染，build 不会报错。

**注意**：`app-relay`、`agent-relay`、`outbound-relay-client` 是完全不同的功能
（App 分发、组聊 Agent 中继、出站中继），不要一起删。

## 已知既有失败（非本轮引入）

server 20 条。`coding-agents-launch`(4) 与 `group-chat-member-sync`(1) 已修复：
那五条断言把本地端口写死成 6060，而本 fork 默认监听 8648，代码本身是对的。

剩余构成：

- `agent-bridge-python-concurrency`(2)：Python bridge 并发，需真实 bridge 环境
- `hermes-web-ui-mcp`(2)、`profiles-routes`(2)、`sessions-routes`(14)：模块级 mock 边界

client 全绿（289 文件 / 1983 用例）。

