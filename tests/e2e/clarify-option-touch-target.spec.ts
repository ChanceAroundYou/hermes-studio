import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

async function open(page: Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  const notNow = page.getByRole('button', { name: 'Not now' })
  await notNow.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible({ timeout: 60_000 })
}

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    return runs[0] ? runs[0].payload : null
  }, null, { timeout: 60_000 })
  return handle.jsonValue() as Promise<any>
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(inputPlaceholder).fill(text)
  const notNow = page.getByRole('button', { name: 'Not now' })
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
  await page.getByRole('button', { name: 'Send' }).click()
}

/** Ask a real clarification through the socket the way the server does. */
async function askWithChoices(page: Page, choices: string[]) {
  const sid = (await waitForRun(page)).session_id
  await page.evaluate(({ sessionId, options }) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    state.broadcast('run.started', { session_id: sessionId, run_id: 'run-c' })
    state.broadcast('clarify.requested', {
      event: 'clarify.requested',
      session_id: sessionId,
      run_id: 'run-c',
      clarify_id: 'clarify-c',
      question: 'Which one do you want?',
      choices: options,
      response_mode: 'choice',
      timeout_ms: 300000,
    })
  }, { sessionId: sid, options: choices })
  return sid
}

async function measureChoice(page: Page, index = 0) {
  const button = page.locator('.approval-float-actions .n-button').nth(index)
  await expect(button).toBeVisible({ timeout: 20_000 })
  return button.evaluate(el => {
    const style = getComputedStyle(el)
    const content = el.querySelector('.n-button__content') as HTMLElement | null
    return {
      height: el.getBoundingClientRect().height,
      cssHeight: style.height,
      minHeight: style.minHeight,
      paddingTop: parseFloat(style.paddingTop),
      paddingBottom: parseFloat(style.paddingBottom),
      contentHeight: content?.getBoundingClientRect().height ?? 0,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }
  })
}

test('a clarification choice has vertical padding around its text', async ({ page }) => {
  await open(page)
  await page.setViewportSize({ width: 412, height: 900 })
  await page.waitForTimeout(300)

  await send(page, 'ask me something')
  await askWithChoices(page, ['任务计划卡片', '看板 / 工作流任务'])
  const metrics = await measureChoice(page)

  // The request was padding, not size: no padding left a 20px label flush
  // against the box edge.
  expect(metrics.paddingTop).toBeGreaterThanOrEqual(6)
  expect(metrics.paddingBottom).toBeGreaterThanOrEqual(6)
  // The box is the text plus that padding, not a number someone picked.
  const expected = metrics.contentHeight + metrics.paddingTop + metrics.paddingBottom
  expect(Math.abs(metrics.height - expected)).toBeLessThanOrEqual(2)
})

test('the padding is never turned into a fixed height', async ({ page }) => {
  await open(page)
  await page.setViewportSize({ width: 412, height: 900 })
  await page.waitForTimeout(300)

  await send(page, 'ask me something else')
  // First choice is short, second wraps onto several lines.
  await askWithChoices(page, [
    '短选项',
    '这是一个非常长的选项文本，它会在窄屏上换行成多行，用来证明按钮高度是跟着内容长的而不是被固定住的',
  ])

  const short = await measureChoice(page, 0)
  const long = await measureChoice(page, 1)

  // A locked height would make these equal and clip the second one.
  expect(long.contentHeight).toBeGreaterThan(short.contentHeight)
  expect(long.height).toBeGreaterThan(short.height)
  expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth + 1)
  expect(['auto', 'min-content', 'max-content', 'fit-content']).toContain(long.minHeight)
})

test('the dismiss button is padded like the choices beside it', async ({ page }) => {
  await open(page)
  await page.setViewportSize({ width: 412, height: 900 })
  await page.waitForTimeout(300)

  await send(page, 'ask a third time')
  await askWithChoices(page, ['第一个选项', '第二个选项'])
  await expect(page.locator('.approval-float-actions')).toBeVisible({ timeout: 20_000 })

  // One rule covers the whole row, so a button added later cannot come out
  // tighter than the ones already there.
  const padding = await page.locator('.approval-float-actions .n-button').evaluateAll(nodes =>
    nodes.map(node => {
      const style = getComputedStyle(node)
      return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) }
    }),
  )
  expect(padding.length).toBeGreaterThan(1)
  for (const entry of padding) {
    expect(entry.top).toBeGreaterThanOrEqual(6)
    expect(entry.bottom).toBeGreaterThanOrEqual(6)
  }
})