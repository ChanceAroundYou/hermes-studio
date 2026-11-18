import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

// Each test boots the whole app against a dev server. Sharing the host with the
// other worker pushes that boot past the default 30s budget, which then reads as
// a missing composer rather than a slow one.
test.describe.configure({ timeout: 90_000 })

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

async function open(page: Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  const notNow = page.getByRole('button', { name: 'Not now' })
  await notNow.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
  await expect(page.getByPlaceholder(inputPlaceholder)).toBeVisible({ timeout: 60_000 })
}

/** A first-visit dialog can reopen after typing and would swallow the click. */
async function dismissModal(page: Page) {
  const notNow = page.getByRole('button', { name: 'Not now' })
  if (await notNow.isVisible().catch(() => false)) {
    await notNow.click()
    await notNow.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
  }
}

/**
 * The chat socket only exists once a run has started, and the cross-session
 * delivery path needs a live connection to arrive on.
 */
async function startRun(page: Page, text: string) {
  await page.getByPlaceholder(inputPlaceholder).fill(text)
  await dismissModal(page)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return Boolean(state?.emitted?.some((item: any) => item.event === 'run'))
  }, null, { timeout: 60_000 })
}

/** Deliver one profile-room event, the way the server's side does. */
async function deliver(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(({ name, body }) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    for (const socket of state.sockets) socket.__trigger(name, { event: name, ...body })
  }, { name: event, body: payload })
}

/** A prompt for a session the user is not looking at: notification is its only surface. */
const awayPrompt = (clarifyId: string) => ({
  session_id: 'session-elsewhere',
  run_id: 'run-elsewhere',
  clarify_id: clarifyId,
  question: 'Answer this from another session?',
  choices: ['Yes', 'No'],
  response_mode: 'choice',
  timeout_ms: 300000,
  remaining_timeout_ms: 300000,
  profile: 'research',
})

const notificationCard = (page: Page) => page.locator('.pending-interaction-card--notification')

/**
 * Measures the same four things the plan's acceptance list names: the card for a
 * session you are not looking at arrives, it is answerable, answering it leaves,
 * and a prompt the server settles stops being answerable.
 */
test('a prompt from another session arrives and can be answered', async ({ page }) => {
  await open(page)
  await startRun(page, 'start a conversation')

  await deliver(page, 'clarify.requested', awayPrompt('clarify-away'))

  const card = notificationCard(page)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.getByRole('button', { name: 'Yes' }).click()

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return (state?.emitted || [])
      .filter((item: any) => item.event === 'clarify.respond')
      .map((item: any) => item.payload?.clarify_id)
  }), { timeout: 20_000 }).toContain('clarify-away')
})

test('a prompt the server settles stops being answerable', async ({ page }) => {
  await open(page)
  await startRun(page, 'start another conversation')

  await deliver(page, 'clarify.requested', awayPrompt('clarify-settled'))
  const card = notificationCard(page)
  await expect(card).toBeVisible({ timeout: 20_000 })
  // It is answerable before the server says otherwise.
  await expect(card.getByRole('button', { name: 'Yes' })).toBeVisible()

  // The turn that asked is over: the server refuses the prompt. What matters is
  // that the client stops offering it, instead of leaving a card that looks
  // answerable and silently drops the click.
  await deliver(page, 'clarify.resolved', {
    session_id: 'session-elsewhere',
    run_id: 'run-elsewhere',
    clarify_id: 'clarify-settled',
    resolved: false,
    reason: 'cancelled',
    profile: 'research',
  })

  await expect(card).toHaveCount(0, { timeout: 20_000 })
})

/**
 * The phone browser is the mobile carrier, so the card has to be reachable there.
 * The toaster slides in from beyond the right edge, which is why this measures
 * only once it has settled -- sampled mid-flight it reads the transition.
 */
test('the whole card fits a phone viewport once it settles', async ({ page }) => {
  await open(page)
  await page.setViewportSize({ width: 412, height: 900 })
  await startRun(page, 'phone width')
  await deliver(page, 'clarify.requested', awayPrompt('clarify-phone'))

  const card = notificationCard(page)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(2_500)

  const box = await card.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const button = el.querySelector('button')?.getBoundingClientRect()
    return {
      left: rect.left, right: rect.right, viewport: window.innerWidth,
      buttonLeft: button?.left ?? -1, buttonRight: button?.right ?? -1,
    }
  })

  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(box.viewport)
  // The controls must be inside too, not only the box that holds them.
  expect(box.buttonLeft).toBeGreaterThanOrEqual(0)
  expect(box.buttonRight).toBeLessThanOrEqual(box.viewport)
})
