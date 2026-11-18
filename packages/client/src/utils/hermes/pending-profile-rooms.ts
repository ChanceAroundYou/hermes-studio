/**
 * How many profile rooms one socket may ask for.
 *
 * A user's profile list is bounded in practice, so this only exists to keep a
 * malformed or hostile handshake value from becoming an unbounded `join` loop.
 */
export const MAX_PENDING_PROFILE_ROOMS = 50

/**
 * Which `pending-interactions:<profile>` rooms one connection should join.
 *
 * A prompt is published to the room of the profile that asked for it, so a
 * connection that only sits in the active profile's room cannot show a prompt
 * raised on any other profile the user owns. The active profile is always
 * included: an unknown or empty profile store must not cost the user the
 * prompt on the profile they are actually looking at.
 */
export function pendingProfileRoomNames(
  accessible: ReadonlyArray<string | null | undefined>,
  active: string,
): string[] {
  const names = [...accessible, active]
    .map(name => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean)
  return [...new Set(names)].slice(0, MAX_PENDING_PROFILE_ROOMS)
}

/** The value the socket handshake carries; socket.io query values are strings. */
export function pendingProfileRoomQuery(
  accessible: ReadonlyArray<string | null | undefined>,
  active: string,
): string {
  return JSON.stringify(pendingProfileRoomNames(accessible, active))
}
