import { errorMessage } from '@/utils/format'

export async function responseErrorMessage(
  response: Response,
  fallbackPrefix = 'Request failed',
): Promise<string> {
  let detail = ''

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      detail = errorMessage(await response.clone().json())
    } catch {
      detail = ''
    }
  }

  if (!detail) {
    try {
      detail = (await response.clone().text()).trim()
    } catch {
      detail = ''
    }
  }

  const base = `${fallbackPrefix}: ${response.status}`
  return detail ? `${base} - ${detail}` : base
}
