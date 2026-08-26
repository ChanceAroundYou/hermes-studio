import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { checkToken, recordTokenFailure, extractIp } from './login-limiter'
import { getWebUiHome } from '../config'

function getAppHome(): string {
  return getWebUiHome()
}
function getTokenFile(): string {
  return join(getWebUiHome(), '.token')
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Get or create the auth token.
 */
export async function getToken(): Promise<string> {
  if (process.env.AUTH_TOKEN) {
    return process.env.AUTH_TOKEN
  }

  try {
    const token = await readFile(getTokenFile(), 'utf-8')
    return token.trim()
  } catch {
    const token = generateToken()
    await mkdir(getAppHome(), { recursive: true })
    // Only set mode on Unix systems (Windows ignores this)
    const options: any = {}
    if (process.platform !== 'win32') {
      options.mode = 0o600
    }
    await writeFile(getTokenFile(), token + '\n', options)
    return token
  }
}

/**
 * Koa middleware: check Authorization header or query token.
 * No path whitelisting — applied globally after public routes.
 */
export function requireAuth(token: string | null) {
  return async (ctx: any, next: () => Promise<void>) => {
    const auth = ctx.headers.authorization || ''
    const provided = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : (ctx.query.token as string) || ''

    if (!provided || provided !== token) {
      // Skip auth for non-API paths (SPA static files)
      const lowerPath = ctx.path.toLowerCase()
      if (!lowerPath.startsWith('/api') && !lowerPath.startsWith('/v1') && !lowerPath.startsWith('/upload')) {
        await next()
        return
      }

      // Check rate limiter for token auth failures (separate IP counters from password login)
      const ip = extractIp(ctx)
      const result = checkToken(ip)
      if (!result.allowed) {
        ctx.status = result.status
        ctx.set('Content-Type', 'application/json')
        ctx.body = { error: 'Too many login attempts, please try again later' }
        return
      }

      recordTokenFailure(ip)
      ctx.status = 401
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: 'Unauthorized' }
      return
    }

    await next()
  }
}
