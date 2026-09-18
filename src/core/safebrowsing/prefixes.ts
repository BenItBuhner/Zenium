import { registrableDomain } from '../blocking/domain'
import { sha256 } from './sha256'

/**
 * Hash-prefix tables: what a Safe Browsing feed becomes once loaded. Each host is reduced to the
 * first 8 bytes of its SHA-256 (64 bits: no practical false positives at feed sizes of a few
 * hundred thousand, one sixth of the memory of the hostnames, and a superset of Google Safe
 * Browsing's 4-byte prefixes so a remote lookup can share the canonicalisation). Tables are
 * sorted `BigUint64Array`s and answer a lookup with a binary search; the Kotlin engine mirrors
 * the format (`privacy/SafeBrowsing.kt`) from the same files.
 */

export const PREFIX_BYTES = 8

/** The first {@link PREFIX_BYTES} bytes of `sha256(expression)` as one big-endian integer. */
export function prefixOf(expression: string): bigint {
  const digest = sha256(expression)
  return new DataView(digest.buffer, digest.byteOffset, PREFIX_BYTES).getBigUint64(0, false)
}

/**
 * The expressions a hostname is looked up under: the host itself and each parent down to its
 * registrable domain (`a.b.example.com` → `a.b.example.com`, `b.example.com`, `example.com`);
 * never a public suffix on its own. IP literals are looked up as they are.
 */
export function hostExpressions(hostname: string): string[] {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return []
  const base = registrableDomain(host)
  if (base === host || !host.endsWith(`.${base}`)) return [host]
  const out = [host]
  let rest = host
  for (;;) {
    const dot = rest.indexOf('.')
    if (dot === -1) break
    rest = rest.slice(dot + 1)
    out.push(rest)
    if (rest === base) break
  }
  return out
}

export class PrefixTable {
  /** Sorted (unsigned) and deduplicated. A plain field: the snapshot script runs this under Node's type stripping. */
  private readonly values: BigUint64Array

  private constructor(values: BigUint64Array) {
    this.values = values
  }

  static empty(): PrefixTable {
    return new PrefixTable(new BigUint64Array(0))
  }

  get size(): number {
    return this.values.length
  }

  has(prefix: bigint): boolean {
    const v = this.values
    let lo = 0
    let hi = v.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const x = v[mid]
      if (x === prefix) return true
      if (x < prefix) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }

  /** The expression of `hostname` (see {@link hostExpressions}) the table holds, or null. */
  matchHost(hostname: string): string | null {
    if (this.values.length === 0) return null
    for (const expression of hostExpressions(hostname))
      if (this.has(prefixOf(expression))) return expression
    return null
  }

  /** Build from hostnames (already normalised: lowercase, no trailing dot). */
  static fromHosts(hosts: Iterable<string>): PrefixTable {
    const list = Array.from(hosts)
    const values = new BigUint64Array(list.length)
    for (let i = 0; i < list.length; i++) values[i] = prefixOf(list[i])
    return PrefixTable.fromValues(values)
  }

  /**
   * Build from many hostnames without holding the thread: hashes `chunk` hosts, then yields to
   * the event loop before the next chunk.
   */
  static async fromHostsChunked(hosts: readonly string[], chunk = 4000): Promise<PrefixTable> {
    const values = new BigUint64Array(hosts.length)
    for (let start = 0; start < hosts.length; start += chunk) {
      const end = Math.min(hosts.length, start + chunk)
      for (let i = start; i < end; i++) values[i] = prefixOf(hosts[i])
      if (end < hosts.length) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    return PrefixTable.fromValues(values)
  }

  /** From concatenated big-endian prefixes in any order (trailing partial prefixes are dropped). */
  static fromBytes(bytes: Uint8Array): PrefixTable {
    const count = Math.floor(bytes.length / PREFIX_BYTES)
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * PREFIX_BYTES)
    const values = new BigUint64Array(count)
    for (let i = 0; i < count; i++) values[i] = view.getBigUint64(i * PREFIX_BYTES, false)
    return PrefixTable.fromValues(values)
  }

  private static fromValues(values: BigUint64Array): PrefixTable {
    values.sort()
    let unique = 0
    for (let i = 0; i < values.length; i++) {
      if (i > 0 && values[i] === values[i - 1]) continue
      values[unique++] = values[i]
    }
    return new PrefixTable(unique === values.length ? values : values.slice(0, unique))
  }

  /** Sorted big-endian prefixes, {@link PREFIX_BYTES} each. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.values.length * PREFIX_BYTES)
    const view = new DataView(out.buffer)
    for (let i = 0; i < this.values.length; i++)
      view.setBigUint64(i * PREFIX_BYTES, this.values[i], false)
    return out
  }

  toBase64(): string {
    return bytesToBase64(this.toBytes())
  }

  static fromBase64(text: string): PrefixTable {
    return PrefixTable.fromBytes(base64ToBytes(text))
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step)
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)))
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  let binary: string
  try {
    binary = atob(text.replace(/\s+/g, ''))
  } catch {
    return new Uint8Array(0)
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
