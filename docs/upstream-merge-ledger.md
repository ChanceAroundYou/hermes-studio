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
| （配套测试修复） | `25741c477` | #3246 新增 socket 订阅，6 个 vi.mock 需补 onRunUsageUpdated |

## fork 保留下来的定制（合并时逐项确认）

| 定制 | 位置 | 合并策略 |
|---|---|---|
| 会话头部 header-identity + workspace-badge | ChatPanel.vue | 叠在上游 PageHeader / HeaderSidebarToggle 基底上 |
| 收藏走 workspacePreferences | FolderPicker.vue | 快捷行整块保留，上游重构只用于目录树 |
| 触屏长按 = 上下文菜单 | FolderPicker.vue | 上游删了手势，绑回行 wrapper |
| 共用 PendingInteractionCard | MessageList + GroupChatPanel | 上游拆成两段内联面板，接回共用卡片 |
| /hermes/ 子路径资源 | index.html + 头像 getBaseUrlValue() | 全程保留 |
| 并行多 profile | chat-run.ts | 不引入上游更弱的 requireSocketSessionReadAccess |
| 移动端 Enter 换行 | ChatInput.vue | 上游删了分支，补回 |
| error role -> system | HistoryView.vue | 保留 |

## 已知既有失败（非本轮引入）

server 21 条：agent-bridge-python-concurrency(2)、coding-agents-launch（Codex 配置）、
hermes-web-ui-mcp(2)、profiles-routes(2)、sessions-routes(14)。

client 全绿（284 文件 / 1942 用例）。
