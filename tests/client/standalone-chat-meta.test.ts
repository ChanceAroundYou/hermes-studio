import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), 'utf8')

/** The router entry for one named route. */
function routeEntry(source: string, name: string): string {
  const start = source.indexOf(`name: '${name}'`)
  expect(start, `route ${name} not found`).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('},', start))
}

/**
 * The global pending layer answers prompts by profile, which needs an account
 * behind the tab. A public share link has none, so the layer has to stay off
 * those routes -- and it has to stay off for the reason it is off today, or a
 * later refactor will loosen it by accident.
 */
describe('shared chat routes never mount the global pending layer', () => {
  it('marks every public share surface as standalone', () => {
    const router = read('router/index.ts')
    for (const name of ['share.groupChat', 'groupChat.link']) {
      expect(routeEntry(router, name), name).toContain('standaloneChat: true')
    }
  })

  it('leaves the ordinary in-app chat surfaces alone', () => {
    const router = read('router/index.ts')
    for (const name of ['hermes.chat', 'hermes.session']) {
      expect(routeEntry(router, name), name).not.toContain('standaloneChat: true')
    }
  })

  it('keeps the mount condition keyed off that one flag', () => {
    const app = read('App.vue')
    const start = app.indexOf('<GlobalPendingActions')
    expect(start).toBeGreaterThan(-1)
    const tag = app.slice(start, app.indexOf('/>', start))
    expect(tag).toContain('v-if="!isLoginPage && !isDesktopPetRoute && !isStandaloneChatPage"')
  })
})
