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

### 5b. 新增信息流条目前，先查是否已有来源

把压缩结果写进信息流后，用户看到同一事实出现两遍：一条是我注入的
`Compressed 229 msgs: ~71.8K → …`，一条是 `/compact` 服务端本来就
persist 的 `Compression completed: 229 -> 9 messages, …`。

`session-command.ts` 的 `emitCommand()` 会同时做两件事——`persistCommandMessage()`
写库 + `state.messages.push()`，以及 `emitToSession()` 推 live 事件。命令类消息
本来就已经是信息流里的一等公民。

**新增任何信息流条目前，先确认服务端没有已经产出对应的持久消息。**
自动压缩（run 内触发的）确实没有 command 消息，所以那条仍然需要注入；
`/compact` 有，就不能重复。区分依据是 `state.source`。

这个错误本可以更早发现：截图里 `/compact` 卡片和我的条目同时出现，
只要看一眼就知道服务端早有产出。查数据库确认过一次——每次压缩在库里
只有一条 `Compression completed`，所以客户端那条重复来自我的注入，
不是既有的重投问题。

### 6. 说明规则的注释，本身可能违反规则

`tests/client/rtl-logical-css.test.ts` 扫描 CSS 里的物理方向属性（`border-right`、
`margin-left` 等）。给压缩动画的 spinner 写注释时用了
`/* Logical, not border-right-color: ... */` 来解释为什么用
`border-inline-end-color` —— 注释里那个属性名被测试当成真实声明，测试失败。

有意思的是**第一版声明本身就是错的**：我确实写了 `border-right-color`，
是测试先抓到的，才改成逻辑属性。顺序是「声明违规 → 改声明 → 注释仍违规」，
两次失败看起来是同一个。

写这类注释时不要引用被禁用的字面量。用「physical side」「物理方向」描述，
不要把属性名抄进来。

### 7. 行为测试覆盖不到的规则，要明确说明并改用源码断言

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
