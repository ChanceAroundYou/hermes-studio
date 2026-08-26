// Shared multipart upload helper — used by both /upload and group-chat invite
// attachments. Keeps the request stream alive when we break early on oversize
// so the client receives 413 instead of ECONNRESET. Cloud clients may need
// ~2min to drain a body already in flight.
const REJECTED_REQUEST_DRAIN_TIMEOUT_MS = 2 * 60 * 1000

/** Return an async iterator that does NOT destroy the stream on early return. */
export function nonDestroyingRequestBody(req: any): any {
  return typeof req?.iterator === 'function'
    ? req.iterator({ destroyOnReturn: false })
    : req
}

/** Drain the remainder of a rejected body so the HTTP error reaches the client. */
export function drainRejectedRequest(req: any): Promise<void> {
  if (!req || typeof req.resume !== 'function' || req.readableEnded || req.destroyed) return Promise.resolve()
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer)
      req.off?.('end', finish)
      req.off?.('close', finish)
      req.off?.('error', finish)
      resolve()
    }
    // Bound the work for clients that never finish sending the rejected body.
    const timer = setTimeout(() => {
      req.destroy?.()
      finish()
    }, REJECTED_REQUEST_DRAIN_TIMEOUT_MS)
    timer.unref?.()
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', finish)
    req.resume()
  })
}
