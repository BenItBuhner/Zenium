/**
 * `chrome.instanceID`, the host-neutral part: Chrome's Instance ID format
 * (`InstanceIDImpl::EnsureIDGenerated`), its error texts (`instance_id_api.cc`) and the
 * parameter checks of `getToken` / `deleteToken`. The ID is local state, generated on first use
 * and stable until `deleteID`; tokens come from Google's GCM channel, which only Chrome has, so
 * the token calls fail the way Chrome reports Instance ID with GCM off (`InstanceID::DISABLED`,
 * beside `chrome.gcm`'s `GCM_DISABLED`).
 */

/** `InstanceID::DISABLED`: GCM is off for this profile. */
export const INSTANCE_ID_DISABLED = 'Instance ID is disabled.'
/** `InstanceID::INVALID_PARAMETER`. */
export const INSTANCE_ID_INVALID_PARAMETER = 'Function was called with invalid parameters.'

/** Chrome's `kInstanceIDByteLength`. */
const ID_BYTE_LENGTH = 8

export interface InstanceIdRecord {
  id: string
  /** Milliseconds since the epoch when the ID was generated. */
  creationTime: number
}

/**
 * Chrome's ID from 8 random bytes: the top four bits of the first byte carry the version 0x7,
 * the bytes are base64 encoded URL-safe (`-` and `_`) with the padding removed: 11 characters,
 * the first one of `c`, `d`, `e`, `f`.
 */
export function formatInstanceId(bytes: Uint8Array): string {
  if (bytes.length !== ID_BYTE_LENGTH) throw new Error(`Instance ID needs ${ID_BYTE_LENGTH} bytes`)
  const versioned = Uint8Array.from(bytes)
  versioned[0] = (versioned[0] & 0x0f) | 0x70
  let binary = ''
  for (const byte of versioned) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isInstanceIdRecord(value: unknown): value is InstanceIdRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.creationTime === 'number' &&
    Number.isFinite(record.creationTime)
  )
}

/**
 * `getToken`'s `getTokenParams` / `deleteToken`'s `deleteTokenParams` as Chrome's schema takes
 * them: `authorizedEntity` and `scope` strings, `options` (getToken) a string-valued map.
 */
export function validateTokenParams(raw: unknown): { authorizedEntity: string; scope: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(INSTANCE_ID_INVALID_PARAMETER)
  const params = raw as Record<string, unknown>
  const authorizedEntity = params.authorizedEntity
  const scope = params.scope
  if (typeof authorizedEntity !== 'string') throw new Error(INSTANCE_ID_INVALID_PARAMETER)
  if (typeof scope !== 'string') throw new Error(INSTANCE_ID_INVALID_PARAMETER)
  if (params.options !== undefined) {
    const options = params.options
    if (options === null || typeof options !== 'object' || Array.isArray(options))
      throw new Error(INSTANCE_ID_INVALID_PARAMETER)
    for (const value of Object.values(options as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(INSTANCE_ID_INVALID_PARAMETER)
    }
  }
  return { authorizedEntity, scope }
}
