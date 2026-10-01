/** Per-account storage limits. A write past one is refused with a typed `ConvexError`. */
export const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024
export const MAX_DOCUMENTS = 4096
export const MAX_BYTES = 128 * 1024 * 1024

/**
 * Characters per chunk. Convex stores strings as UTF-8, so 256 Ki UTF-16 code units are at most
 * 768 KiB: under the 1 MiB document limit for any text.
 */
export const CHUNK_CHARS = 256 * 1024

/** Same alphabet as a sync folder's file names (`deviceFileName` in the client). */
export const DOCUMENT_NAME = /^[A-Za-z0-9._-]{1,200}$/

/**
 * `sync:readMany` stops before its answer passes this many characters (the client asks again for
 * the rest). Sync documents are base64 ciphertext, so characters are bytes: well under Convex's
 * 16 MiB read and return limits and the Android bridge's 16 MB response cap, and never below one
 * document of the largest size.
 */
export const READ_MANY_MAX_CHARS = 8 * 1024 * 1024
export const READ_MANY_MAX_NAMES = 64

export const LINK_TTL_MS = 10 * 60 * 1000
/**
 * How long a device may repeat a step whose answer it never received: the previous refresh token
 * after a rotation, or the approved link's poll after the session was created. Past it, the
 * previous token counts as reuse and revokes the session.
 */
export const RETRY_GRACE_MS = 60 * 1000
export const ACCESS_TOKEN_TTL_S = 60 * 60
export const REVOKED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DELETE_BATCH = 200
export const MAX_DEVICE_NAME = 100

/** Crockford-like: no 0/O, 1/I/L, so a code read off a screen cannot be mistyped. */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export const DEVICE_AUDIENCE = 'zenium-device'
