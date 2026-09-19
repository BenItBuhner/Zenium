import type { ProtectionCheck } from '../../shared/privacy'
import { GSB_SEARCH_ENDPOINT } from '../safebrowsing/gsb'

/**
 * The two checks behind the busy forms of Settings > Privacy and Security (design-language-v2-
 * draft §9.30): a Google Safe Browsing key is tried against the API before it is kept, and a
 * custom DNS-over-HTTPS resolver is asked one question before it is used. The forms stay busy
 * for the one request each check makes and are refused with `problem` as their validation text.
 * Pure: the requests are built here, sent by the services (`../safebrowsing/service.ts`,
 * `./service.ts`); the result type is `shared/privacy.ts`'s {@link ProtectionCheck}.
 */

/** A prefix that is on no list – 4 zero bytes – so the answer is only whether the key is taken. */
const KEY_PROBE_PREFIX = 'AAAAAA=='

/** The `hashes:search` request that tries `apiKey`, or null for a key that cannot be sent. */
export function apiKeyProbeUrl(apiKey: string): string | null {
  const key = apiKey.trim()
  if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) return null
  const params = new URLSearchParams()
  params.set('key', key)
  params.set('hashPrefixes', KEY_PROBE_PREFIX)
  return `${GSB_SEARCH_ENDPOINT}?${params.toString()}`
}

/**
 * What one HTTP answer to the probe says about the key: 400 and 403 are Google refusing the key
 * itself (`API_KEY_INVALID`, `PERMISSION_DENIED` when the Safe Browsing API is not enabled for
 * it); anything else – a hit list, an empty answer, a quota reply – means the key is taken.
 */
export function apiKeyCheckOf(status: number, body: string): ProtectionCheck {
  if (status === 400 || status === 401 || status === 403) {
    const reason = googleErrorMessage(body)
    return {
      ok: false,
      problem: reason
        ? `Google rejected this key: ${reason}`
        : status === 403
          ? 'Google rejected this key: the Safe Browsing API is not enabled for it'
          : 'Google rejected this key'
    }
  }
  return { ok: true }
}

function googleErrorMessage(body: string): string | null {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } }
    const message = json.error?.message
    return typeof message === 'string' && message ? message.replace(/\.$/, '') : null
  } catch {
    return null
  }
}

/** The name the resolver is asked for: one that every resolver answers. */
export const RESOLVER_PROBE_NAME = 'example.com'

/**
 * A DNS query for `name`'s A record in wire format (RFC 1035 §4.1): a 12-byte header with the
 * recursion-desired bit and one question, the name as length-prefixed labels, type A, class IN.
 */
export function dnsQuery(name: string): Uint8Array {
  const labels = name
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean)
    .map((label) => new TextEncoder().encode(label))
  const size = 12 + labels.reduce((n, label) => n + 1 + label.length, 0) + 1 + 4
  const out = new Uint8Array(size)
  // id 0 (RFC 8484 §4.1: a zero id lets caches share the answer), flags 0x0100 (RD), QDCOUNT 1.
  out[2] = 0x01
  out[5] = 0x01
  let at = 12
  for (const label of labels) {
    out[at++] = label.length
    out.set(label, at)
    at += label.length
  }
  out[at++] = 0
  out[at++] = 0
  out[at++] = 1
  out[at++] = 0
  out[at++] = 1
  return out
}

/** Base64url without padding, as RFC 8484 §6 wants the `dns` parameter. */
export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The GET that asks the resolver at `template` for {@link RESOLVER_PROBE_NAME}: the query in the
 * `dns` parameter where the template has `{?dns}` (RFC 8484 §4.1), appended as a query parameter
 * where it has not (Chromium sends POST there; a GET is what every resolver also takes). Null for
 * a template that is not a usable DoH address.
 */
export function resolverProbeUrl(template: string): string | null {
  const text = template.trim()
  if (!/^https:\/\//i.test(text)) return null
  const dns = base64Url(dnsQuery(RESOLVER_PROBE_NAME))
  const url = text.includes('{?dns}')
    ? text.replace('{?dns}', `?dns=${dns}`)
    : `${text}${text.includes('?') ? '&' : '?'}dns=${dns}`
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password)
      return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** What the resolver's answer says: an answer at all is the resolver; anything else is not. */
export function resolverCheckOf(status: number): ProtectionCheck {
  if (status >= 200 && status < 300) return { ok: true }
  return {
    ok: false,
    problem: `The resolver did not answer a DNS-over-HTTPS query at this address (HTTP ${status})`
  }
}

/** The check a resolver that could not be reached at all gets. */
export const RESOLVER_UNREACHABLE: ProtectionCheck = {
  ok: false,
  problem: 'Zenium could not reach a resolver at this address'
}
