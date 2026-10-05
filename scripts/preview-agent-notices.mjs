#!/usr/bin/env node
/**
 * Render a static preview of the agent's run-time status bubbles.
 *
 * The point is to let someone judge the *styling* without needing a run to
 * happen at the right moment. A status line only exists while a turn is alive,
 * is replaced in place, and is deleted when the run settles -- so waiting to see
 * one in the wild is a bad way to review two colours and a border.
 *
 * This does not redraw anything. It reads the CSS out of `dist/client/`, takes
 * the scope attribute the components are compiled with, and emits markup with
 * the same classes and the same attribute, so what you look at is what ships.
 *
 *   BASE_URL=/hermes/ npm run build
 *   node scripts/preview-agent-notices.mjs            # writes the HTML
 *   node scripts/preview-agent-notices.mjs --png      # also screenshots it
 *
 * Output goes to `.ekko-tmp/` unless --out is given.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const cssDir = path.join(root, 'dist/client/assets/css')

const argv = process.argv.slice(2)
const wantPng = argv.includes('--png')
const outIdx = argv.indexOf('--out')
const outDir = path.resolve(root, outIdx >= 0 ? argv[outIdx + 1] : '.ekko-tmp')

// ── Locate the stylesheet the message component compiled into ──────────────
if (!fs.existsSync(cssDir)) {
  console.error('no build found at dist/client/assets/css -- run: BASE_URL=/hermes/ npm run build')
  process.exit(1)
}

const candidates = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'))
let cssFile = null
let scope = null
for (const file of candidates) {
  const text = fs.readFileSync(path.join(cssDir, file), 'utf8')
  // The bubble rules and the theme tokens ship in the same chunk, so one file
  // gives us both the styles and the scope id.
  const match = text.match(/\[(data-v-[0-9a-f]+)\]:root/)
  if (match && text.includes('.message-bubble.agent-error')) {
    cssFile = file
    scope = match[1]
    break
  }
}
if (!cssFile) {
  console.error('could not find the compiled message stylesheet (no chunk with .message-bubble.agent-error)')
  process.exit(1)
}

const cssPath = path.join(cssDir, cssFile)

// Each case is one row of docs/agent-status-notices.md section 3.
const CASES = [
  ['1. 阻塞 —— 等待另一个进程', 'system', 'agent-error',
    '⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn...',
    'agent 的 turn 租约被别的进程占着，这一轮还没开始。'],
  ['2. 阻塞续报', 'system', 'agent-error',
    '⏳ Still waiting for the other Hermes process on this session (12s)...',
    '同一行的更新，秒数递增。'],
  ['3. warn 类', 'system', 'agent-error',
    '⚠ compression model unavailable',
    'agent 自己标为 warn 的降级路径（kind="warn"）。'],
  ['4. 真正的失败（对照，本轮未改）', 'system', 'agent-error',
    'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded).',
    '既有的 BRIDGE_FAILURE_PATTERNS 路径。'],
  ['5. 进度 —— 压缩', 'system', 'notice',
    '📦 Preflight compression: ~120,000 tokens >= 100,000 threshold. This may take a moment.',
    'run 自己在做维护，会自行结束，不需要处理。'],
  ['6. 进度 —— 记忆召回', 'system', 'notice',
    '🧠 Memory — recalled 3 memories',
    '同上。'],
  ['7. 进度 —— 闲置恢复', 'system', 'notice',
    '💤 Resumed after 3600s idle — compressing ~120,000 tokens before continuing.',
    '同上。'],
  ['8. 对照 —— 普通回复必须保持中性', 'assistant', '',
    'Error handling in the parser looks correct, so I left it alone.',
    '正是历史上被误涂红过的那类文本。'],
]

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const sections = CASES.map(([title, role, extra, text, why]) => {
  const msgClass = ['message', role].filter(Boolean).join(' ')
  const bubbleClass = ['message-bubble', extra].filter(Boolean).join(' ')
  return `<section>
  <h2>${esc(title)}</h2>
  <p class="why">${esc(why)}</p>
  <div class="${msgClass}" ${scope}>
    <div class="msg-body" ${scope}>
      <div class="${bubbleClass}" ${scope}><div ${scope}>${esc(text)}</div></div>
    </div>
  </div>
</section>`
}).join('\n')

const html = `<!doctype html>
<html ${scope} lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent 状态行样式预览</title>
<link rel="stylesheet" href="${cssPath}">
<style>
  body { margin: 0; padding: 20px; background: #fafafa; font-family: system-ui, -apple-system, "Noto Sans SC", sans-serif; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .lead { color: #666; font-size: 13px; margin: 0 0 22px; line-height: 1.7; }
  section { margin: 0 0 22px; padding: 14px 16px; background: #fff; border-radius: 10px; border: 1px solid #eee; }
  h2 { font-size: 14px; margin: 0 0 3px; }
  .why { color: #888; font-size: 12px; margin: 0 0 12px; }
  code { background: #f2f2f2; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>Agent 状态行样式预览</h1>
<p class="lead">
  直接引用构建产物 <code>dist/client/assets/css/${cssFile}</code>，class 与 scope 属性
  （<code>${scope}</code>）与线上一致。<br>
  没有真实 run，所以气泡是静态的 —— 但颜色、边框、圆角、留白都是真的。<br>
  规则见 <code>docs/agent-status-notices.md</code>。
</p>
${sections}
</body>
</html>
`

fs.mkdirSync(outDir, { recursive: true })
const htmlPath = path.join(outDir, 'bubble-preview.html')
fs.writeFileSync(htmlPath, html)
console.log('wrote', htmlPath)
console.log('scope', scope, ' css', cssFile)

if (wantPng) {
  const browser = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
    .map(name => {
      try {
        return execFileSync('command', ['-v', name], { shell: true, encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })
    .find(Boolean)
  if (!browser) {
    console.error('--png given but no chromium/chrome on PATH; open the HTML instead')
    process.exit(0)
  }
  const pngPath = path.join(outDir, 'bubble-preview.png')
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=900,1900', `--screenshot=${pngPath}`, `file://${htmlPath}`,
  ], { stdio: 'ignore' })
  console.log('wrote', pngPath)
}
