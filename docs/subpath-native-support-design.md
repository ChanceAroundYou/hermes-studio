# Hermes Web UI 内置子路径支持 — 分阶段迁移方案

> 目标：代码层内置 `/hermes/` 路径常量，完全移除对 nginx sub_filter/rewrite 的依赖
> 支持 `http://host:6060/hermes/` 和 `https://domain/hermes/` 两种方式无需额外配置

---

## 一、路径流转分析（当前 vs 目标）

### 1.1 当前路径流（nginx rewrite + sub_filter 模式）

```
外部: https://domain/hermes/api/hermes/health
  → nginx sub_filter: 前端注入 /hermes 前缀（JS 层面）
  → nginx rewrite: ^/hermes(/.*) $1 break
  → 后端收到: /api/hermes/health
  → basePath stripping: 不匹配 /hermes（已被 nginx 剥离）→ 不剥离
  → 路由匹配: /api/hermes/health ✅
```

**关键发现：当前 basePath stripping 在 nginx 后面是冗余的（已被 nginx rewrite 剥离）**
但它在直接 6060 访问时是必需的。

### 1.2 目标路径流（代码级路径常量 + nginx 透传模式）

```
外部: https://domain/hermes/api/hermes/health
  → nginx: 直接透传（无 rewrite，无 sub_filter）
  → 后端收到: /hermes/api/hermes/health
  → basePath stripping: 匹配 /hermes → 剥离 → /api/hermes/health
  → 路由匹配: /api/hermes/health ✅

直接: http://localhost:6060/hermes/api/hermes/health
  → basePath stripping: 匹配 /hermes → 剥离 → /api/hermes/health
  → 路由匹配: /api/hermes/health ✅

直接: http://localhost:6060/api/hermes/health（根路径模式）
  → basePath stripping: 不匹配 → 不剥离
  → 路由匹配: /api/hermes/health ✅
```

---

## 二、分阶段迁移方案

### 阶段 0：前置准备（无功能变更）

**目的：** 确保所有修改点定位准确，无遗漏。

| 步骤 | 操作 | 验证 |
|------|------|------|
| 0.1 | 备份当前代码、dist、DB、nginx 配置 | `git stash` + `cp -a` |
| 0.2 | 确认当前 nginx 配置和后端 basePath stripping 状态 | 记录 baseline |
| 0.3 | 确认所有需要修改的代码点 | 见第三章 |

### 阶段 1：后端兼容性改造（低风险，无破坏性）

**目的：** 后端同时接受裸路径和 `/hermes/` 路径，为前端改造做准备。

#### 1.1 改进 basePath stripping 中间件

**当前代码（server/index.ts）：**
```typescript
const basePath = (process.env.HERMES_BASE_PATH || '/').replace(/\/$/, '')
if (basePath && basePath !== '/') {
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith(basePath)) {
      ctx.path = ctx.path.slice(basePath.length) || '/'
      ctx.request.url = ctx.path + (ctx.request.search || '')
    }
    await next()
  })
}
```

**问题：** 如果后端 basePath stripping 在 nginx rewrite 之后执行，路径已经被剥离，basePath stripping 不生效。
**解决：** basePath stripping 保持不变（它在 nginx 之后时是无操作，不破坏功能；在 nginx 透传时生效）。

**实际上当前代码不需要修改！** 它在两种模式下都不破坏功能：
- nginx rewrite 模式：路径已剥离，stripping 不匹配 → 不操作 ✅
- nginx 透传模式：路径有 `/hermes/` 前缀，stripping 匹配 → 剥离 ✅

#### 1.2 后端静态资源处理增强

**当前 koa-static 处理：** 通过 `serve(distDir)` 处理 `dist/` 下的所有文件。

**问题：** index.html 中的裸路径（`/favicon.ico`、`/logo.png`、`/manifest.webmanifest`）在子路径模式下变成：
- 直接访问：`http://localhost:6060/favicon.ico` → koa-static 匹配 ✅
- 子路径访问：`http://localhost:6060/hermes/favicon.ico` → koa-static 匹配 `/hermes/favicon.ico` ❌

**解决：** 在 koa-static 之前增加静态资源路径重写：

```typescript
// 静态资源路径重写（子路径模式下）
if (basePath && basePath !== '/') {
  app.use(async (ctx, next) => {
    const staticAssets = ['/favicon.ico', '/logo.png', '/manifest.webmanifest']
    if (staticAssets.includes(ctx.path)) {
      await next()
      return
    }
    // 子路径模式下的静态资源请求：/hermes/favicon.ico → /favicon.ico
    for (const asset of staticAssets) {
      const subPathAsset = `${basePath}${asset}`
      if (ctx.path === subPathAsset) {
        ctx.path = asset
        ctx.request.url = asset
        break
      }
    }
    await next()
  })
}
```

**但更好的方案：** 让 index.html 中通过 `getAppBase()` 拼接路径，避免需要后端重写。

**结论：阶段 1 后端代码无需修改，阶段 2 前端修改后自然兼容。**

### 阶段 2：Vite 构建配置改造（前端路径常量注入）

**目的：** 构建时注入 `__APP_BASE_PATH__`，所有前端路径自动拼接。

#### 2.1 vite.config.ts 修改

**修改前：**
```typescript
const BASE_URL = './'
```

**修改后：**
```typescript
const HERMES_BASE_PATH = process.env.HERMES_BASE_PATH || ''
const BASE_URL = HERMES_BASE_PATH
  ? HERMES_BASE_PATH + '/'  // '/hermes/' for subpath mode
  : './'                    // relative for root mode
```

**添加 define：**
```typescript
define: {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __APP_BASE_PATH__: JSON.stringify(HERMES_BASE_PATH),  // NEW
}
```

**影响：** 无运行时破坏，仅构建时行为变化。

### 阶段 3：前端 client.ts 核心修改

**目的：** 将路径常量从 nginx sub_filter 注入改为代码级注入。

#### 3.1 client.ts 修改

**修改前：**
```typescript
const DEFAULT_BASE_URL = ''

function getBaseUrl(): string {
  if (import.meta.env.VITE_HERMES_PREVIEW === '1') return DEFAULT_BASE_URL
  if (isDesktopShell()) return DEFAULT_BASE_URL
  return localStorage.getItem('hermes_server_url') || DEFAULT_BASE_URL
}
```

**修改后：**
```typescript
// 构建时注入的子路径常量，例如 '/hermes'
declare const __APP_BASE_PATH__: string
const DEFAULT_BASE_PATH = __APP_BASE_PATH__ || ''

export function getAppBase(): string {
  return DEFAULT_BASE_PATH
}

function getBaseUrl(): string {
  if (import.meta.env.VITE_HERMES_PREVIEW === '1') return DEFAULT_BASE_PATH
  if (isDesktopShell()) return DEFAULT_BASE_PATH
  return localStorage.getItem('hermes_server_url') || DEFAULT_BASE_PATH
}
```

**效果：** `getBaseUrl()` 现在返回 `/hermes`（构建时注入），不再依赖 nginx sub_filter。

**过渡期兼容性：** 
- 旧 dist 在内存中运行时，`__APP_BASE_PATH__` 不存在 → 编译失败
- 新 dist 构建后，`__APP_BASE_PATH__` = '/hermes' → `getBaseUrl()` 返回 '/hermes'

### 阶段 4：静态资源路径改造

**目的：** 所有静态资源引用通过 `getAppBase()` 拼接。

#### 4.1 `chat-agent-avatar.ts` 修改

**修改前：**
```typescript
export const AGENT_ICONS: Record<string, { label: string; src: string }> = {
  hermes: { label: 'Hermes', src: '/coding-agents/hermes.png' },
  // ...
}
```

**修改后：**
```typescript
import { getAppBase } from '@/api/client'
const BASE = getAppBase()

export const AGENT_ICONS: Record<string, { label: string; src: string }> = {
  hermes: { label: 'Hermes', src: BASE + '/coding-agents/hermes.png' },
  // ...
}
```

#### 4.2 `stores/chat.ts` 中图标引用（同上）

#### 4.3 `App.vue` 中 logo 引用

**修改前：**
```vue
<img src="/logo.png" ... />
```

**修改后：**
```typescript
import { getAppBase } from '@/api/client'
const logoPath = getAppBase() + '/logo.png'
```
```vue
<img :src="logoPath" ... />
```

#### 4.4 `index.html` 中静态资源引用

**关键问题：** index.html 是静态文件，Vite 构建时会自动处理 `src="/src/main.ts"` 和 `href` 中的相对路径，但 `href="/favicon.ico"` 和 `href="/logo.png"` 是绝对路径，Vite 不会处理。

**方案：** 在 Vite 构建后，通过构建脚本替换 index.html 中的静态资源路径。

```typescript
// vite.config.ts 中添加 build.rollupOptions.output 的 transformIndexHtml
plugins: [
  vue(),
  {
    name: 'transform-index-html',
    transformIndexHtml(html, ctx) {
      // 在构建时替换 index.html 中的裸路径
      const base = __APP_BASE_PATH__ || ''
      return html
        .replace(/href="\/favicon\.ico"/g, `href="${base}/favicon.ico"`)
        .replace(/href="\/logo\.png"/g, `href="${base}/logo.png"`)
        .replace(/href="\/manifest\.webmanifest"/g, `href="${base}/manifest.webmanifest"`)
        .replace(/href="\/src\/main\.ts"/g, `href="${base}/src/main.ts"`)
        .replace(/src="\/logo\.png"/g, `src="${base}/logo.png"`)
        .replace(/url\("\/logo\.png"\)/g, `url("${base}/logo.png")`)
        .replace(/mask: url\("\/logo\.png"\)/g, `mask: url("${base}/logo.png")`)
    }
  }
]
```

**风险：** index.html 的 build-time 修改可能导致缓存问题。
**缓解：** 构建后验证 index.html 内容，确保所有路径正确。

### 阶段 5：Vue Router 路径修复

**目的：** 移除硬编码 `/hermes/` 前缀（使用 hash history，路径仅用于直接 URL 访问）。

#### 5.1 `router/index.ts` 修改

**修改前：**
```typescript
path: '/hermes/chat'
path: '/hermes/history'
// ...
```

**修改后：**
```typescript
path: '/chat'
path: '/history'
// ...
```

**影响分析：** 
- Hash 模式下（`#/chat`），路径仅用于 hash 片段，浏览器不向服务器发送路径
- 但 hash 是浏览器内部导航，路径变更不影响已打开的会话
- 直接 URL 访问 `https://domain/hermes/#/hermes/chat` → 改为 `https://domain/hermes/#/chat`
- 用户书签会失效（这是破坏性变更）

**缓解方案：** 在 router 中添加重定向逻辑，兼容旧 hash：
```typescript
{
  path: '/hermes/:hash(.*)',
  redirect: to => ({ path: `/${to.params.hash}` }),
}
```

#### 5.2 `login-redirect.ts` 修改

**修改前：**
```typescript
const DEFAULT_LOGIN_REDIRECT = '/hermes/chat'
```

**修改后：**
```typescript
const DEFAULT_LOGIN_REDIRECT = '/chat'
```

#### 5.3 `completion-notification.ts` 修改

**修改前：**
```typescript
if (!value || !value.startsWith('/hermes/'))
```

**修改后：**
```typescript
if (!value || !value.startsWith(getAppBase() + '/'))
```

### 阶段 6：nginx 配置简化（最后一步）

**目的：** 移除所有 sub_filter 和 rewrite，只保留透传。

#### 6.1 nginx 配置简化

**修改前（hermes.conf）：**
```nginx
# 6 条 sub_filter 规则
# 3 处 rewrite
# 2 处 proxy_buffering on
# 1 处 proxy_set_header Accept-Encoding ''
```

**修改后：**
```nginx
# 静态资源 — 直接透传，后端 koa-static 处理
location ~ ^/hermes/(assets|icons|fonts|\.ico|manifest\.webmanifest|logo\.png|logo-original\.png|notification-sw\.js)$ {
    proxy_pass http://127.0.0.1:6060;
    proxy_cache hermes_cache;
    proxy_cache_valid 200 30d;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# 一切其他（API, Socket.IO, SPA）
location /hermes/ {
    proxy_pass http://127.0.0.1:6060;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Origin "https://$host";
    proxy_buffering off;
    client_max_body_size 10G;
}
```

**效果：**
- 0 条 sub_filter
- 0 处 rewrite
- 0 处 gzip 禁用
- 2 个 location 块（vs 原来 4 个）

---

## 三、阶段执行顺序与验证点

| 阶段 | 操作 | 执行 | 验证 | 回退 |
|------|------|------|------|------|
| **0** | 备份 | 代码+dist+DB+nginx | 备份完整性 | - |
| **1** | 后端兼容性 | 无需修改（现有代码已兼容） | 路径流分析确认 | - |
| **2** | Vite 构建配置 | 修改 `vite.config.ts` | 构建无 TS 错误 | `git checkout` |
| **3** | client.ts 核心修改 | 修改 `client.ts` | `getBaseUrl()` 返回 `/hermes` | `git checkout` |
| **4** | 静态资源路径 | 修改 avatar/utils/App.vue/index.html | 构建后图片路径正确 | `git checkout` |
| **5** | Router 路径 | 修改 router + redirect | 路由跳转正常 | `git checkout` |
| **6** | nginx 简化 | 修改 hermes.conf | `nginx -t` + 功能测试 | 恢复备份 |

**关键约束：**
- 阶段 1-5 可以在不重启 nginx 的情况下完成（构建新 dist）
- 阶段 6（nginx 修改）是最后一步，修改后**必须**已验证阶段 2-5 全部正确
- 阶段 5 中的 Router 重定向必须与阶段 6 同步部署，否则用户访问旧 hash URL 会 404

---

## 四、破坏性变更清单与迁移策略

| 变更 | 影响 | 迁移策略 |
|------|------|----------|
| Router hash 路径 `/hermes/chat` → `/chat` | 用户书签失效 | 添加 router redirect 兼容旧 hash |
| localStorage `hermes_server_url` 格式变更 | 旧值 `'/hermes'` 与新值 `'/'` 兼容 | `getBaseUrl()` 已有空值 fallback，兼容 |
| index.html 静态资源路径 | 构建产物中的 HTML 字符串变化 | Vite build-time 转换，与 JS 产物同步 |
| sub_filter 移除 | nginx 不再修改 JS 响应 | 代码级路径常量完全替代 |

---

## 五、完整回退方案

### 5.1 代码回退
```bash
cd ~/.local/share/hermes-web-ui
git checkout <pre-migration-branch>
npm run build
systemctl --user restart hermes-webui
```

### 5.2 nginx 配置回退
```bash
cp /etc/nginx/conf.d/home/hermes.conf.bak.$TIMESTAMP /etc/nginx/conf.d/home/hermes.conf
nginx -t && systemctl reload nginx
```

### 5.3 混合状态处理

如果只完成了阶段 1-5 但阶段 6 未完成：
- 前端 JS 发送 `/hermes/` 路径（通过 `__APP_BASE_PATH__`）
- nginx sub_filter 注入 `/hermes` 到 `getBaseUrl()`（旧机制）
- nginx rewrite 剥离 `/hermes/` 前缀
- 后端 basePath stripping 不生效（已被 nginx 剥离）
- **结论：阶段 1-5 完成但阶段 6 未完成时，系统仍然正常运行**

如果只完成了阶段 6 但阶段 1-5 未完成：
- 前端 JS 发送裸路径（通过 sub_filter 注入，但 sub_filter 已被移除）
- 后端 basePath stripping 不生效（路径不含 `/hermes`）
- **结论：阶段 6 单独执行会破坏系统！必须与阶段 1-5 同步完成。**

---

## 六、迁移决策图

```
阶段 0: 备份
  │
  ▼
阶段 1: 后端兼容检查
  │  结论：当前代码无需修改（已兼容）
  ▼
阶段 2-5: 前端代码改造
  │  修改点：vite.config.ts, client.ts, avatar/utils, App.vue,
  │          index.html, router/index.ts, login-redirect.ts,
  │          completion-notification.ts
  │
  ▼  npm run build  → dist 更新
  │
  ▼
阶段 6: nginx 简化
  │  修改：移除 sub_filter/rewrite，仅保留透传
  │  nginx -t 验证
  │  nginx reload
  │
  ▼
验证：端到端测试
  │  curl /hermes/health → 200
  │  curl /hermes/coding-agents/hermes.png → PNG
  │  浏览器访问 /hermes/ → SPA 正常加载
  │  终端面板 WebSocket 连接正常
  │  聊天消息正常收发
  │  TTS 合成正常
```

---

## 七、验证清单（每阶段后）

### 阶段 2-3 后验证：
```bash
# 构建产物检查
grep "__APP_BASE_PATH__" dist/client/assets/js/index-*.js | head -3
# 期望：JS 产物中包含 '/hermes' 字符串

# getBaseUrl() 返回值
curl -s https://home.xiaokubao.space/hermes/api/hermes/health
# 期望：返回 200 + JSON
```

### 阶段 4 后验证：
```bash
# 图片路径
curl -s -o /dev/null -w "%{http_code}" https://home.xiaokubao.space/hermes/coding-agents/hermes.png
# 期望：200

# 静态资源
curl -s -o /dev/null -w "%{http_code}" https://home.xiaokubao.space/hermes/logo.png
# 期望：200
```

### 阶段 5 后验证：
```bash
# Router 重定向
curl -s https://home.xiaokubao.space/hermes/#/hermes/chat | grep -o 'location.reload\|replace' | head -1
# 期望：hash 重定向生效

# 直接访问
curl -s -o /dev/null -w "%{http_code}" https://home.xiaokubao.space/hermes/#/chat
# 期望：200
```

### 阶段 6 后验证：
```bash
# nginx 配置语法
nginx -t
# 期望：syntax is ok

# sub_filter 移除确认
grep -c "sub_filter" /etc/nginx/conf.d/home/hermes.conf
# 期望：0

# 功能测试
curl -s https://home.xiaokubao.space/hermes/health
# 期望：返回 200 + JSON
```
