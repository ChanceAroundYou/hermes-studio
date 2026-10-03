import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

async function sendChatMessage(page: Page, message: string) {
  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible({ timeout: 60_000 })
  await input.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    return runs[0] ? runs[0].payload : null
  })
  return handle.jsonValue() as Promise<any>
}

async function box(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
  }, selector)
}

/**
 * Two regressions of the run indicator, in one run because each setup costs a
 * cold boot of the dev server:
 *
 * 1. Width. The thinking row sat 4px inside the message column on each side and
 *    the reasoning box was additionally capped at a hard 520px, so on a phone it
 *    was 8px narrower than the messages above it and on a desktop it was 411px
 *    short. Width parity with the message column is the intent; assert the box
 *    edges, not the inner text, so a long answer cannot fake a match.
 * 2. Ownership. An in-flight tool has to live in the trailing transcript card
 *    rather than in a live box of its own, or it renders as a second card.
 */
async function expectSpansMessageColumn(page: Page, selector: string) {
  // .virtual-row is the row wrapper every message shares, so it is the stable
  // edge of the column; an assistant row would also work but its bubble
  // shrink-wraps its text.
  const column = await box(page, '.virtual-row')
  expect(column, 'message column missing').not.toBeNull()
  const measured = await box(page, selector)
  expect(measured, `${selector} missing`).not.toBeNull()
  console.log(`${selector.padEnd(26)} left=${measured!.left} right=${measured!.right} column=${column!.left}..${column!.right}`)
  expect(measured!.left, `${selector} left edge`).toBe(column!.left)
  expect(measured!.right, `${selector} right edge`).toBe(column!.right)
}

test('the run indicator matches the message column and owns the in-flight tool', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')

  // A first-run dialog can cover the composer; the chat-streaming specs never
  // meet it because their dev server is already warm.
  const notNow = page.getByRole('button', { name: 'Not now' })
  await notNow.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await notNow.isVisible().catch(() => false)) await notNow.click()

  await sendChatMessage(page, 'Measure the run indicator')
  const run = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-width' })
    socket.__trigger('reasoning.delta', {
      event: 'reasoning.delta',
      session_id: sid,
      run_id: 'run-width',
      delta: 'Inspecting the pending work before answering.',
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-width',
      delta: 'Working on it.',
    })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-width',
      tool_call_id: 'width-1',
      tool: 'read_file',
      arguments: { path: 'queue.json' },
    })
  }, run.session_id)

  await expect(page.locator('.live-reasoning-detail')).toBeVisible()
  await expect(page.locator('.thinking-status')).toBeVisible()

  // An in-flight call already owns its transcript card, keyed by the run id and
  // carrying the spinner in its header; its row only appears once the dropdown
  // is opened, and there is no second live box anywhere.
  const card = page.locator('.tool-run-card[data-run-id="run-width"]')
  await expect(card).toContainText('read_file')
  await expect(card.locator('.tool-run-spinner')).toBeVisible()
  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.locator('.live-tool-run')).toHaveCount(0)

  // The phone case from the bug report.
  await page.setViewportSize({ width: 412, height: 900 })
  await page.waitForTimeout(300)
  await expectSpansMessageColumn(page, '.thinking-status')
  await expectSpansMessageColumn(page, '.live-reasoning-detail')

  // Desktop, where the hard 520px cap left the box far short of the column.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(300)
  await expectSpansMessageColumn(page, '.thinking-status')
  await expectSpansMessageColumn(page, '.live-reasoning-detail')
})