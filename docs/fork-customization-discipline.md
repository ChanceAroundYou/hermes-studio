# Fork 定制纪律

本 fork 通过 cherry-pick 跟进上游，结构性冲突的既定策略是**整取上游**。
这个策略对布局重写是对的，但它会静默丢掉和上游改写在同一个文件里的 fork 行为。

本文件记录由此产生的纪律。**清单本体是 `tests/client/fork-customizations.test.ts`**，
本文只解释纪律本身。

## 为什么需要这份清单

已经发生过两次同形状的丢失，都出自 #3232（`1c8692c07`）那次整取上游：

| 被丢的定制 | 引入 commit | 表现 |
|---|---|---|
| 思考头像下方的 120px 固定间隙 | `79a7ae8a2` | 完成后头像悬在一大片空白上方 |
| 消息头部的 Profile 显示名 | `a440c83ac` | 新会话又显示 `default` 而非「小鸡毛」 |

两次都没被拦住，原因是同一个：**行为本身的测试一直全绿，因为被删掉的是调用点。**

`resolveProfileDisplayName` 一直好好的、测试全绿——只是没人再调它了。
一个纯函数单元测试无法察觉「没人调用」。

## 纪律

### 1. 清单断言接线，不断言行为

`tests/client/fork-customizations.test.ts` 只回答一个问题：**这次合并有没有把它留下**。

- 行为验证留在各自专门的测试里（`chat-error-bubble-style.test.ts`、错误分类器测试等）。
- 清单断言的是 hook / 索引 / 路由 / 组件**是否还在该在的地方被引用**。

一个定制被**有意替换**时，改断言，**不要删条目**——这样清单仍然是「本 fork 与上游分歧在哪」的记录，
分歧史不会随重构消失。

### 2. 合并完立刻跑清单

```bash
npx vitest run tests/client/fork-customizations.test.ts   # 1 秒
```

比事后靠界面发现强。这是合上游的收尾闸门，和 build / 全量测试同级。

### 3. 清单本身必须 mutation 验证

新增条目后，把对应源码改回损坏状态，确认该条目**失败**。

真实案例：断言「思考块没有固定高度」最初写成
`expect(src).not.toMatch(/streaming-indicator[\s\S]{0,400}height:\s*120px/)`，
把 `height: auto` 改回 `height: 120px` 后测试**仍然通过**——规则块里的说明注释
让 `[\s\S]{0,400}` 的窗口没能覆盖到声明处。

改成直接切出规则块、只断言它声明了什么：

```ts
const block = src.slice(src.indexOf('.streaming-indicator {'))
const body = block.slice(0, block.indexOf('}'))
expect(body).toMatch(/height:\s*auto/)
```

**不 mutation 验证，就不知道自己写的断言是不是空的。**
本文件建立时用 5 条真实回归逐个验证：alias 回退、`height: 120px`、深灰 raw chip、
索引去掉 DESC 列、去掉 profile switch 等待——5 条全部被捕获。

### 4. 审计「缺失」之前，先确认不是自己查错了路径

系统复查时有 3 处初判缺失，逐一追查后确认是我查错了文件：

- `advanceLastActiveForSession` 已移到 `repositories/session-store.ts`
- `withTaskPlanTurnContext` 在 `services/task-plan-runs.ts`，不在 `services/chat-run/`
- 组聊面板在 `components/hermes/group-chat/`，不在 `components/hermes/chat/`

**用 `git show <sha> --stat` 拿到当时的真实路径，再 `grep` 那个路径。**
凭记忆里的目录结构 grep 会同时制造假阳和假阴性。

### 5. 红线也写进清单

`handle-bridge-run` 的 stale 循环里**不得**清 `isWorking`——会与 owner 竞态，丢掉最终回复。
这类「不要这样做」的不变式同样进清单，否则下一次重构很容易顺手加回去。

## 强制：所有来自指定源的修改，必须同时写入清单并加守卫

**这条是硬性要求，不是建议。**

### 「指定源」指什么

以下四类改动，**无论来自哪个会话、哪个 agent、哪次 cherry-pick**，一律视为「指定源」：

1. **修 bug 的改动** —— 尤其是修「已复现但未定位到根因」的那类
2. **跨文件协调的改动** —— 一个行为依赖两个及以上文件协同
3. **撤销/取代既有行为的改动** —— 即使旧行为看起来是错的
4. **编译产物、配置、profile 设置等非代码变更**

判定标准一句话：**如果这次改动做完后没有任何测试会因为它被回退而失败，它就没被守住。**

### 三步，缺一不可

```
1. 写代码
2. 写入 docs/upstream-merge-ledger.md 的定制表（人类可读）
3. 写入 tests/client/fork-customizations.test.ts（机器守接线）
   + 在对应行为测试文件里加用例
```

### 为什么必须这样

本轮发现一个具体教训：那批「彩环不消失 + 通知延时」的修复，
**代码和守卫测试都写好了，但整个批次停在工作区，从未提交**。
`git log` 查不到，测试文件是untracked。
一次 cherry-pick、一次 `git checkout`、一次误清理，就能无声抹掉它。

所以第0 步其实是：

```bash
git status --short        # 每次会话开始，以及每次提交前
```

**工作区里有已验证但未提交的修复，等于没有修复。**

### 提交前自检

- [ ] `git status --short` 里没有本会话遗留的未提交改动（除非明确知道它在做什么）
- [ ] ledger 定制表里有对应行
- [ ] 清单里有对应 describe 分组
- [ ] 行为测试有对应 it
- [ ] 新增断言做过 mutation，且**每条都真的转红过**
- [ ] 非代码变更（.gitignore、配置）也写进了纪律或 ledger

最后一条最容易漏：`.gitignore` 加规则、profile 外部目录、skill frontmatter ——
这些都不是代码，但都是「回来会出问题」的改动，同样要记录。

### 6. 断言必须落在「使用点」，不是「声明点」

合并清单里最容易写出空壳断言的方式，是断言一个常量或方法**被声明**，而不是**被使用**。

本轮两条实测漏网（`fork-customizations.test.ts`）：

```ts
// 漏的版本：只断言常量存在
expect(files.chatStore).toMatch(/SUBAGENT_EVIDENCE_FRESHNESS_MS/)
// 变异：把守卫分支换成裸 return true —— 测试仍然全绿，
// 而死锁已经回来了。

// 改成断言使用点
expect(body).toMatch(/now - subagent\.updatedAt < SUBAGENT_EVIDENCE_FRESHNESS_MS/)
```

```ts
// 漏的版本：断言方法名出现过（全文件共 4 处，赋值处被变异仍匹配到别处）
expect(files.chatRunSocket).toMatch(/backgroundPendingCount\(state\)/)
// 变异：把调用换成常量 0 —— 测试仍然全绿。

// 改成切出赋值块再断言
const block = listing.slice(0, listing.indexOf('\n      }'))
expect(block).toMatch(/backgroundPending = this\.backgroundPendingCount\(state\)/)
```

规律：

- **声明点存活、使用点被改** 是最常见的合并回归形态。
- 断言必须切出**具体代码块**再匹配，不能对整个文件跑宽松正则。
- 修好之后**必须重跑 mutation** —— 前一版「全绿」本身就是它已经空壳的证据。

### 7. 一个机制的两个症状，要放在同一个清单分组里

本轮的症状是两条独立抱怨：「侧栏彩环不消失」和「通知有延时」。
诊断发现它们是**同一个机制的两面**：

- 彩环 = `isStreaming`，三个来源OR（socket 流 / 服务端快照 / 活跃委派）
- 通知有三条完成路径，而**只有轮询路径**会去重

于是非当前会话的通知延迟 = 轮询间隔（当时 12s），彩环泄漏与通知缺失同源。

**清单分组按机制，不按症状。** 否则修好一边，另一边会在合并时重新漂移。
同理，`sidebar-live-settle.test.ts`（行为）和 `fork-customizations.test.ts`（接线）
覆盖同一机制的两个层面，应同时更新，不能只改一个。

## 派生结论：纯函数测试需要接线测试配套

任何「纯函数 + 多个调用点」的设计，都应配一层接线测试：

```ts
expect(source).toMatch(/resolveProfileDisplayName\(\s*profilesStore\.profiles,/)
expect(source).not.toMatch(/activeSessionProfile\.value\?\.alias\?\.trim\(\) \|\|/)
```

两个断言缺一不可：正向证明调用存在，负向钉住那个**具体的**损坏写法
（`alias` 回退会让有显示名无 alias 的 profile 静默落回 `default`）。

注意本项目单双引号混用，import 断言要写成引号无关的正则
（`["']@/utils/...["']`），否则会因为格式而非代码失败，被误读成 bug。

### 5.1 新增信息流条目前，先问三个问题

把压缩结果写进信息流时，接连返工了三次。三个问题当时就该先问：

**1. 服务端是否已经产出对应记录？**

`/compact` 的 `emitCommand()` 会 `persistCommandMessage()` 写库 + 推 live。
我加了一条客户端注入的记录，同一事实显示两遍。

但这个"重复"其实是**掩盖了真正的缺口**：run 内自动压缩**完全没有**任何
记录。修法不是"command 来源跳过注入"，而是让服务端为两种来源都持久化一条
统一形状的记录。

**2. 到底要持久化还是不要？**

我第一版按"不持久"做，第二轮用户明确要持久。中间浪费一整轮。
"临时状态"和"历史事实"是两种东西——压缩永久丢弃上下文，它是历史事实。

**3. "唯一"是指一条记录，还是一种样式？**

我理解成"不重复注入"，用户的意思是**一条记录**：`Compressing...` 就地变成
最终结果，而不是旁边多出一条。live 态和持久态按 `startedAt` 合并成同一个
对象，这才是"一条"。

### 5.2 持久化之后，合并逻辑要在所有替换消息列表的路径上

`recordCompressionEntry` 只在收到压缩事件时合并。但 resume 会整体替换
messages 数组而不触发事件，于是 live 注入的条目和服务器行会并排出现。

三处 `mapHermesMessages` 调用中只有两处需要合并——第三处是深链直接 fetch，
全新加载，不可能有 live 条目。**按调用点数量写断言是错的**，断言必须能区分
哪些路径真的需要。

### 8. 说明规则的注释，本身可能违反规则

`tests/client/rtl-logical-css.test.ts` 扫描 CSS 里的物理方向属性（`border-right`、
`margin-left` 等）。给压缩动画的 spinner 写注释时用了
`/* Logical, not border-right-color: ... */` 来解释为什么用
`border-inline-end-color` —— 注释里那个属性名被测试当成真实声明，测试失败。

有意思的是**第一版声明本身就是错的**：我确实写了 `border-right-color`，
是测试先抓到的，才改成逻辑属性。顺序是「声明违规 → 改声明 → 注释仍违规」，
两次失败看起来是同一个。

写这类注释时不要引用被禁用的字面量。用「physical side」「物理方向」描述，
不要把属性名抄进来。

### 9. 行为测试覆盖不到的规则，要明确说明并改用源码断言

「清空追踪状态时不能删除信息流条目」这条规则，没有任何行为测试能覆盖：
真实清空路径（空闲 resume、离开会话）都会同时重新拉取或丢弃整个消息数组，
所以在 store 层面无法隔离这条规则。实测确认——写出来的行为测试是通过的，
但把 `setCompressionState` 改成在 clear 时连带删除条目，这条测试依然通过。

处理方式：保留行为测试证明它覆盖不到，再补一条源码断言，并把这个理由写进
测试注释。**不要为了让 mutation 变红而给生产代码开测试专用 API**
（试过 `setCompressionStateForTest`，已放弃）。

## 已知既有失败（与本纪律无关）

server 20 条，构成见 `upstream-merge-ledger.md`。client 全绿。

判断回归必须比对**失败名集合**，不能比计数，且先去掉行尾时间戳。
