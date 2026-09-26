import { describe, expect, it, vi } from 'vitest'
import {
  AuthorizedProviderCredentialError,
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../../packages/server/src/modules/hermes/services/providers/authorized-provider-credentials'

describe('authorized provider runtime credentials', () => {
  it('maps the profile auth-store entry without persisting credentials in Studio', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'apc-test-'))
    const profileDir = (profile: string) => join(home, 'profiles', profile)
    try {
      mkdirSync(profileDir('research'), { recursive: true })
      writeFileSync(join(profileDir('research'), 'auth.json'), JSON.stringify({
        providers: {
          'xai-oauth': {
            tokens: { access_token: 'fresh-grok-token' },
            base_url: 'https://api.x.ai/v1/',
            api_mode: 'codex_responses',
            source: 'hermes-auth-store',
            last_refresh: '2026-08-03T09:00:00Z',
          },
        },
      }))

      await expect(resolveAuthorizedProviderRuntimeCredentials({
        profile: 'research',
        provider: 'xai-oauth',
        model: 'grok-4.3',
      }, { profileDir })).resolves.toEqual({
        provider: 'xai-oauth',
        apiKey: 'fresh-grok-token',
        baseUrl: 'https://api.x.ai/v1',
        apiMode: 'codex_responses',
        source: 'hermes-auth-store',
        lastRefresh: '2026-08-03T09:00:00Z',
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('preserves Hermes Agent re-login metadata', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'apc-test-'))
    const profileDir = (profile: string) => join(home, 'profiles', profile)
    try {
      mkdirSync(profileDir('default'), { recursive: true })
      writeFileSync(join(profileDir('default'), 'auth.json'), JSON.stringify({
        providers: {
          'minimax-oauth': {
            tokens: {
              access_token: 'stale-minimax-token',
              expires_at: '2020-01-01T00:00:00.000Z',
            },
          },
        },
      }))

      const promise = resolveAuthorizedProviderRuntimeCredentials({
        profile: 'default',
        provider: 'minimax-oauth',
      }, { profileDir })
      await expect(promise).rejects.toMatchObject({
        provider: 'minimax-oauth',
        code: 'AUTHORIZED_PROVIDER_AUTH_MISSING',
        reloginRequired: true,
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects providers outside the Hermes authorization store before Bridge access', async () => {
    const request = vi.fn()
    expect(isAuthorizedRuntimeProvider('deepseek')).toBe(false)
    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'deepseek',
    }, { request })).rejects.toBeInstanceOf(AuthorizedProviderCredentialError)
    expect(request).not.toHaveBeenCalled()
  })
})
