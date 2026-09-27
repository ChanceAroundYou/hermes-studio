/**
 * Display name for a workspace directory path: the last segment, falling back
 * to the whole path for roots such as `/` or `C:\`.
 *
 * Shared so the chat header, the favourites list and the folder tree all label
 * a workspace the same way instead of each inlining a `split('/').pop()`.
 */
export function workspaceFolderName(path: string | null | undefined): string {
  const raw = String(path || '')
  if (!raw) return ''
  const trimmed = raw.replace(/[/\\]+$/, '')
  // A filesystem root is its own name.
  if (!trimmed) return raw
  // "C:" only makes sense as "C:\".
  if (/^[a-zA-Z]:$/.test(trimmed)) return raw
  return trimmed.split(/[/\\]/).pop() || raw
}
