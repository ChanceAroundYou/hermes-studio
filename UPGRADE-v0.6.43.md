# Hermes Web UI 升级计划：v0.6.42 → v0.6.43

> 生成时间：2026-08-17
> 目标版本：v0.6.43 (commit `d0d72e2a`)
> 当前版本：v0.6.42 (commit `6d8c4edb`)
> 仓库：EKKOLearnAI/hermes-web-ui

---

## 一、现状确认

| 项目 | 当前值 |
|------|--------|
| 本地版本 | v0.6.42 (commit `6d8c4edb`) |
| 主分支 HEAD | v0.6.43 (commit `d0d72e2a`) |
| 落后 main | 21 commits |
| 系统运行版本 | v0.6.41（全局 npm 安装） |
| DB 状态 | 46 张表，无 `app_connections` 等新表 |
| 自定义 commit | 5 个（sub_filter 方案相关） |

---

## 二、主要变更分析

### 1. Socket.IO 路径构造方式改变（必须修复）

| 文件 | v0.6.42 本地 | main v0.6.43 | 风险 |
|------|-------------|--------------|------|
| `chat.ts` | `io(ns, { path: base+'/socket.io' })` | `io(base+ns)` | ⚠️ 子路径下 socket 连接失败 |
| `pet-state.ts` | `io('/pet-state', { path: base+'/socket.io' })` | `io(base+'/pet-state')` | ⚠️ 同上 |
| `workflow-socket.ts` | `io('/workflow', { path: base+'/socket.io' })` | `io(base+'/workflow')` | ⚠️ 同上 |
| `kanban.ts` | `wsOrigin()` helper | `new URL(base).host` | ⚠️ base='' 时抛错 |

**修复方案：** 合并 main 后，对这 4 个文件回退 socket 路径构造方式，保留本地的 `path` 选项写法。

### 2. WebSocket URL 构造改变（必须修复）

- `TerminalPanel.vue`：main 使用 `new URL(base).host`，base='' 时 `new URL('').host` 抛 TypeError
- `kanban.ts`：同上

**修复方案：** 合并 main 后，保留本地的空 base 判断逻辑。

### 3. Pi Agent 集成（main 新增）

- main 新增 `pi.svg` 图标和 Pi RPC 集成
- 本地已有 `pi.svg`（自定义 commit 放入）
- **无需额外处理**，合并时会自动保留

### 4. App Connections 功能（main 新增）

- main 新增 `app_connections`、`app_authorization_codes` 表
- 本地无此功能
- **自动生效**，DB migration 由 server 启动时自动执行

### 5. server/index.ts 变更

- main 新增 Pi MCP 配置迁移逻辑
- main 无 basePath stripping 中间件
- **需手动添加** basePath 中间件（防御性，nginx 已 rewrite 剥离前缀）

---

## 三、升级步骤

### Stage 0 — 备份

```bash
cd /home/xiaokubao/docker/hermes-web-ui

# 1. 回退分支
git branch backup/pre-upgrade-v0.6.43 HEAD

# 2. 备份 dist
cp -a dist dist.bak.$(date +%s)

# 3. 备份 nginx 配置
cp /home/xiaokubao/docker/nginx/conf.d/home/hermes.conf \
   /home/xiaokubao/docker/nginx/conf.d/home/hermes.conf.bak.$(date +%s)

# 4. 备份数据库
cp /home/xiaokubao/.hermes/hermes-web-ui/hermes-web-ui.db \
   /home/xiaokubao/.hermes/hermes-web-ui/hermes-web-ui.db.bak.$(date +%s)

# 5. 备份 systemd unit
cp /home/xiaokubao/.config/systemd/user/hermes-webui.service \
   /home/xiaokubao/.config/systemd/user/hermes-webui.service.bak.$(date +%s)

# 6. 备份 node_modules 关键文件
cp node_modules/node-pty/build/Release/pty.node node_modules/node-pty/build/Release/pty.node.bak.$(date +%s) 2>/dev/null || true
```

### Stage 1 — 拉取并合并

```bash
# 1. 清理工作树
git stash push -m "pre-upgrade-stash" --include-untracked 2>/dev/null || true

# 2. 拉取最新 main
git fetch origin main

# 3. 合并 main
git merge origin/main --no-edit
```

### Stage 2 — 应用子路径修复

合并后，对以下文件应用修复：

#### 文件 1：`packages/client/src/api/hermes/chat.ts`

查找 `chatRunSocket = io(` 行，回退为：
```typescript
const base = baseUrl || ''
chatRunSocket = io(namespace, {
  path: `${base}/socket.io`,
  ...
})
```

#### 文件 2：`packages/client/src/api/hermes/pet-state.ts`

查找 `socket = io(` 行，回退为：
```typescript
const base = getBaseUrlValue() || ''
socket = io('/pet-state', {
  path: `${base}/socket.io`,
  ...
})
```

#### 文件 3：`packages/client/src/api/hermes/workflow-socket.ts`

查找 `socket = io(` 行，回退为：
```typescript
const base = getBaseUrlValue() || ''
socket = io('/workflow', {
  path: `${base}/socket.io`,
  ...
})
```

#### 文件 4：`packages/client/src/api/hermes/kanban.ts`

查找 `new URL(base).host` 行，添加空 base 判断：
```typescript
if (!base) return `${websocketProtocol()}//${location.host}${path}`
return `${websocketProtocol(base)}//${new URL(base).host}${path}`
```

#### 文件 5：`packages/client/src/components/hermes/chat/TerminalPanel.vue`

查找 `new URL(base).host` 行，添加空 base 判断：
```typescript
if (!base) return `${wsProtocol}//${location.host}/api/hermes/terminal...`
return `${wsProtocol}//${new URL(base).host}/api/hermes/terminal...`
```

#### 文件 6：`packages/server/src/index.ts`

在 `createRequestBodyParser()` 后添加 basePath 中间件：
```typescript
// Base-path stripping
const basePath = (process.env.HERMES_BASE_PATH || '/')
  .replace(/\/$/, '')
if (basePath && basePath !== '/') {
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith(basePath)) {
      ctx.path = ctx.path.slice(basePath.length) || '/'
      ctx.request.url = ctx.path + (ctx.request.search || '')
    }
    await next()
  })
  console.log('[bootstrap] base path stripping enabled: %s', basePath)
}
```

### Stage 3 — 构建与验证

```bash
# 1. 安装依赖
npm install

# 2. 重建 node-pty
npm rebuild node-pty

# 3. 构建
npm run build

# 4. 验证构建产物
ls -lh dist/server/index.js dist/client/index.html
node -e "require('./dist/server/index.js')" 2>&1 | head -5  # 检查 TS 错误
```

### Stage 4 — 重启服务

```bash
# 1. 杀掉当前进程（systemd Restart=always 会自拉起）
PID=$(pgrep -f "dist/server/index.js")
kill $PID
sleep 3

# 2. 验证新进程启动
ss -tlnp | grep 6060
curl -s http://localhost:6060/health

# 3. 验证 nginx 子路径
curl -s https://home.xiaokubao.space/hermes/health
curl -s -o /dev/null -w "%{http_code}" https://home.xiaokubao.space/hermes/api/hermes/tts/synthesize
```

### Stage 5 — 功能验证

| 测试项 | 预期结果 |
|--------|----------|
| 聊天正常响应 | 发送消息 → 收到回复 |
| WebSocket 连接 | Terminal 面板可用 |
| TTS 合成 | `/api/hermes/tts/synthesize` → 200 + MP3 |
| 图片加载 | `/hermes/coding-agents/hermes.png` → 200 + PNG |
| Socket.IO | chat/group-chat/kanban/socket 正常连接 |
| Pi Agent | 如有配置，测试 Pi RPC |
| App Connections | 新功能页面可访问 |

---

## 四、Checkpoint 检查清单

### Checkpoint 1: 备份完成
- [ ] `git branch backup/pre-upgrade-v0.6.43` 已创建
- [ ] `dist.bak.*` 已备份
- [ ] `hermes.conf.bak.*` 已备份
- [ ] `hermes-web-ui.db.bak.*` 已备份
- [ ] `hermes-webui.service.bak.*` 已备份

### Checkpoint 2: 合并成功
- [ ] `git merge origin/main` 无冲突
- [ ] `git log --oneline -5` 显示最新 commit
- [ ] 版本为 `0.6.43`

### Checkpoint 3: 修复应用
- [ ] `chat.ts` socket path 已回退
- [ ] `pet-state.ts` socket path 已回退
- [ ] `workflow-socket.ts` socket path 已回退
- [ ] `kanban.ts` WebSocket URL 已添加空 base 判断
- [ ] `TerminalPanel.vue` WebSocket URL 已添加空 base 判断
- [ ] `server/index.ts` basePath 中间件已添加

### Checkpoint 4: 构建成功
- [ ] `npm install` 无错误
- [ ] `npm run build` 退出码 0
- [ ] `dist/server/index.js` 存在且 > 8MB
- [ ] `dist/client/index.html` 存在

### Checkpoint 5: 服务重启
- [ ] 旧进程已 kill
- [ ] 新进程已启动（systemd Restart=always）
- [ ] `ss -tlnp | grep 6060` 显示 listening
- [ ] `curl http://localhost:6060/health` 返回 ok

### Checkpoint 6: 功能验证
- [ ] `curl https://home.xiaokubao.space/hermes/health` → 200
- [ ] TTS 端点 → 200 + MP3
- [ ] 图片端点 `/hermes/coding-agents/hermes.png` → 200 + PNG
- [ ] WebSocket 连接测试（Terminal 面板）
- [ ] 聊天消息发送/接收正常

---

## 五、风险与回退

| 风险 | 缓解措施 |
|------|----------|
| DB 迁移失败 | 备份数据库，手动执行 `CREATE TABLE` |
| sub_filter 不匹配 | 回退 nginx 配置，检查 JS 产物中的路径形态 |
| 构建失败 | 检查 `node_modules` 依赖版本，必要时 `rm -rf node_modules && npm install` |
| 运行崩溃 | `git checkout backup/pre-upgrade-v0.6.43` + 恢复 dist |

**一键回退：**
```bash
git checkout backup/pre-upgrade-v0.6.43
cp dist.bak.* dist -r
cp hermes.conf.bak.* hermes.conf
systemctl --user restart hermes-webui
```

---

## 六、升级后注意事项

1. **DB Schema**：server 启动时会自动创建 `app_connections`、`app_authorization_codes`、`gc_execution_queue` 等新表
2. **Pi Agent**：如需使用 Pi Agent，需配置相应的 provider 和 API key
3. **App Connections**：新功能，可在 Settings 页面访问
4. **sub_filter 规则**：当前 3 条规则仍需保留（getBaseUrl、auth 路径、coding-agents 图标）
