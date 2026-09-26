import { describe, expect, it } from 'vitest'
import { isImageMime, isVideoMime } from '@/utils/attachments'

describe('isImageMime', () => {
  it('accepts the image types the client renders inline', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(true)
  })

  it('rejects everything else, including a missing type', () => {
    expect(isImageMime('video/mp4')).toBe(false)
    expect(isImageMime('application/pdf')).toBe(false)
    expect(isImageMime('')).toBe(false)
    expect(isImageMime(null)).toBe(false)
    expect(isImageMime(undefined)).toBe(false)
  })
})

describe('isVideoMime', () => {
  it('trusts the mime type first', () => {
    expect(isVideoMime('video/mp4')).toBe(true)
    expect(isVideoMime('video/quicktime', 'clip.mov')).toBe(true)
  })

  it('falls back to a known container extension', () => {
    expect(isVideoMime('application/octet-stream', 'clip.webm')).toBe(true)
    expect(isVideoMime('', 'CLIP.MOV')).toBe(true)
    expect(isVideoMime('application/octet-stream', 'notes.txt')).toBe(false)
  })

  it('rejects an empty pair', () => {
    expect(isVideoMime(undefined, undefined)).toBe(false)
    expect(isVideoMime(null, null)).toBe(false)
  })
})
