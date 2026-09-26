/**
 * What the client counts as an inline image or video.
 *
 * The same `type.startsWith('image/')` check had been written out in eight
 * places (including four component-local `isImage()` helpers), and the video
 * one - mime type or a known container extension - in two.
 */
export function isImageMime(type: string | null | undefined): boolean {
  return typeof type === 'string' && type.startsWith('image/')
}

const VIDEO_EXTENSIONS = /\.(?:mp4|mov|m4v|webm)$/i

/** A video is either announced by its mime type or by its file name. */
export function isVideoMime(type: string | null | undefined, name?: string): boolean {
  if (typeof type === 'string' && type.startsWith('video/')) return true
  return typeof name === 'string' && VIDEO_EXTENSIONS.test(name)
}
