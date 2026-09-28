# Hermes Web UI 升级报告：v0.6.42 → v0.6.43

> 完成时间：2026-08-17 17:47
> 升级状态：✅ 成功

---

## 执行摘要

| 项目 | 结果 |
|------|------|
| **版本升级** | v0.6.42 → v0.6.43 |
| **合并 commits** | 21 个（origin/main） |
| **子路径修复** | ✅ 全部应用 |
| **服务运行** | ✅ PID 913564, 端口 6060 |
| **全局统一** | ✅ 本地仓库作为唯一版本 |

---

## Checkpoint 完成确认

### ✅ Checkpoint 0: 备份完成
- [x] `git branch backup/pre-upgrade-v0.6.43` 已创建
- [x] `dist.bak.*` 已备份
- [x] `hermes.conf.bak.*` 已备份
- [x] `hermes-web-ui.db.bak.*` 已备份
- [x] `hermes-webui.service.bak.*` 已备份

### ✅ Checkpoint 1: 合并成功
- [x] `git merge origin/main` 无冲突
- [x] 版本为 `0.6.43`
- [x] HEAD: `e8ec896b local: v0.6.43 子路径定制堆`

### ✅ Checkpoint 2: 修复应用
- [x] `chat.ts` — socket path 回退正确
- [x] `pet-state.ts` — socket path 回退正确
- [x] `workflow-socket.ts` — socket path 回退正确
- [x] `kanban.ts` — WebSocket URL 使用 wsOrigin() helper
- [x] `TerminalPanel.vue` — WebSocket URL 使用 wsOrigin() helper
- [x] `server/index.ts` — basePath 中间件已添加

### ✅ Checkpoint 3: 构建
- [x] dist/server/index.js: 8.6MB (Aug 17 17:19)
- [x] dist/client/index.html: 存在

### ✅ Checkpoint 4: 服务重启
- [x] 进程已启动 (PID 913564)
- [x] 端口 6060 监听中
- [x] systemd 服务状态正常

### ✅ Checkpoint 5: 功能验证
- [x] Health endpoint: `{"status":"ok",...}`
- [x] 子路径 health: `webui_version: 0.6.43`
- [x] TTS 端点: HTTP 401 (需认证)
- [x] 图片端点: `/hermes/coding-agents/hermes.png` → 83161 bytes PNG
- [x] 裸路径隔离: `/coding-agents/hermes.png` → 758 bytes HTML (SPA fallback)

---

## 版本统一方案

### 问题
之前存在两个独立安装：
- 全局 npm 安装：`/home/xiaokubao/.nvm/.../lib/node_modules/hermes-web-ui` (v0.6.41)
- 本地仓库：`/home/xiaokubao/docker/hermes-web-ui` (v0.6.43)

systemd 服务指向全局安装，导致本地修改无法生效。

### 解决方案
将全局安装目录替换为指向本地仓库的符号链接：

```bash
# 备份旧全局安装
mv /home/xiaokubao/.nvm/versions/node/v24.18.0/lib/node_modules/hermes-web-ui \
   /home/xiaokubao/.nvm/versions/node/v24.18.0/lib/node_modules/hermes-web-ui.bak.*

# 创建符号链接
ln -sf /home/xiaokubao/docker/hermes-web-ui \
       /home/xiaokubao/.nvm/versions/node/v24.18.0/lib/node_modules/hermes-web-ui
```

### 当前状态
```
lrwxrwxrwx 1 xiaokubao hermes-web-ui -> /home/xiaokubao/docker/hermes-web-ui
```

**优势：**
- 本地仓库是唯一版本来源
- `git pull` 拉取更新后直接重建 dist
- 无需 `npm install -g` 重复安装
- 所有修改在本地仓库可见可追踪

---

## 关键文件清单

### 修改的源文件
1. `packages/client/src/api/hermes/chat.ts` — socket path 回退
2. `packages/client/src/api/hermes/pet-state.ts` — socket path 回退
3. `packages/client/src/api/hermes/workflow-socket.ts` — socket path 回退
4. `packages/client/src/api/hermes/kanban.ts` — WebSocket URL 保留
5. `packages/client/src/components/hermes/chat/TerminalPanel.vue` — WebSocket URL 保留
6. `packages/server/src/index.ts` — basePath 中间件添加

### 配置不变
- nginx sub_filter 规则（3条）保持不变
- systemd service 配置保持不变
- HERMES_BASE_PATH=/hermes/ 环境变量保持不变

---

## 后续维护

### 更新到最新版本
```bash
cd /home/xiaokubao/docker/hermes-web-ui
git pull origin main
npm run build
systemctl --user restart hermes-webui
```

### 回退到上一个版本
```bash
git checkout backup/pre-upgrade-v0.6.43
systemctl --user restart hermes-webui
```

### 查看 git 历史
```bash
cd /home/xiaokubao/docker/hermes-web-ui
git log --oneline -10
```

---

## 注意事项

1. **node-pty**：已重建，时间戳 Aug 17
2. **DB migration**：server 启动时自动执行，无需手动操作
3. **Pi Agent**：main 新增功能，如需使用需配置 provider
4. **App Connections**：main 新增功能，可在 Settings 页面访问

---

## 升级前后对比

| 项目 | 升级前 | 升级后 |
|------|--------|--------|
| 版本 | v0.6.42 | v0.6.43 |
| 落后 main | 21 commits | 0 commits |
| 全局安装 | v0.6.41 (独立) | v0.6.43 (符号链接) |
| 本地仓库 | v0.6.42 | v0.6.43 |
| Socket.IO 路径 | ✅ 正确 | ✅ 正确 |
| WebSocket URL | ✅ 正确 | ✅ 正确 |
| basePath 中间件 | ✅ 已添加 | ✅ 已添加 |
| Health endpoint | ✅ ok | ✅ ok |
| 图片加载 | ✅ 正常 | ✅ 正常 |
| TTS 端点 | ✅ 正常 | ✅ 正常 |

---

**升级完成！** 🎉
