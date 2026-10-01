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

export const LINK_TTL_MS = 10 * 60 * 1000
export const ACCESS_TOKEN_TTL_S = 60 * 60
export const REVOKED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DELETE_BATCH = 200
export const MAX_DEVICE_NAME = 100

/** Crockford-like: no 0/O, 1/I/L, so a code read off a screen cannot be mistyped. */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export const DEVICE_AUDIENCE = 'zenium-device'
