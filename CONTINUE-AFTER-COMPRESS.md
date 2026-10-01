# Compress 后继续执行的 Prompt

## 背景

已完成 Hermes Web UI 升级计划文档：`/home/xiaokubao/docker/hermes-web-ui/UPGRADE-v0.6.43.md`

## 当前状态

- 本地版本：v0.6.42 (commit `6d8c4edb`)
- 目标版本：v0.6.43 (commit `d0d72e2a`)
- 需要合并 main 分支并应用 6 处子路径修复

## 执行步骤

### 1. 解压恢复（如已压缩）

```bash
cd /home/xiaokubao/docker/hermes-web-ui
# 解压命令（根据压缩格式选择）
# tar xzf hermes-web-ui.tar.gz
# 或 unzip hermes-web-ui.zip
```

### 2. 确认状态

```bash
cd /home/xiaokubao/docker/hermes-web-ui
git status
git log --oneline -3
node -p "require('./package.json').version"
```

### 3. 读取升级计划

```bash
cat /home/xiaokubao/docker/hermes-web-ui/UPGRADE-v0.6.43.md
```

### 4. 按计划执行

严格按照 `UPGRADE-v0.6.43.md` 中的 Stage 0-5 执行，每个 Stage 完成后汇报进度。

### 5. Checkpoint 验证

每完成一个 Stage，确认对应的 Checkpoint 已完成。

## 关键修复点（必须执行）

1. **socket.io 路径**：`chat.ts`、`pet-state.ts`、`workflow-socket.ts` 回退为 `path: base+'/socket.io'`
2. **WebSocket URL**：`kanban.ts`、`TerminalPanel.vue` 添加空 base 判断
3. **server basePath**：`server/index.ts` 添加 HERMES_BASE_PATH stripping 中间件

## 回退方案

如遇问题：
```bash
cd /home/xiaokubao/docker/hermes-web-ui
git checkout backup/pre-upgrade-v0.6.43
cp dist.bak.* dist -r 2>/dev/null || true
systemctl --user restart hermes-webui
```

## 开始执行

请确认当前状态后，开始执行升级计划。每完成一个 Stage 汇报进度。
