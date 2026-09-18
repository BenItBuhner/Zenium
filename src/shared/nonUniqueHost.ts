/**
 * Hosts that are not unique on the public Internet, so no public certificate can name them and
 * HTTPS-only mode leaves them alone, as Chrome's HTTPS-First mode does (`net::IsHostnameNonUnique`):
 *
 * - loopback: `localhost` and any `*.localhost`, `127.0.0.0/8`, `[::1]`;
 * - IP literals in the IANA special-purpose blocks that are not publicly routable (Chromium's
 *   `IPAddress::IsPubliclyRoutable`): private networks (`10/8`, `172.16/12`, `192.168/16`),
 *   link-local (`169.254/16`, `fe80::/10`), `0.0.0.0/8`, the shared address space (`100.64/10`),
 *   unique-local `fc00::/7`, and the documentation, benchmarking, multicast and reserved blocks;
 *   IPv4-mapped and NAT64 addresses are judged by the IPv4 address they carry;
 * - names without a registrable suffix: single-label names (`intranet`) and the special-use and
 *   private suffixes no registry delegates (`.local`, `.internal`, `.test`, `.home.arpa`, `.lan`,
 *   ...). Chrome asks the public suffix list whether a host has a registry-controlled domain at
 *   all (so an unknown suffix is non-unique there); neither host ships the list, so the suffixes
 *   local networks are given are named here instead, and an unknown suffix is upgraded.
 *
 * Pure. `host` is a hostname as `hostnameOf` yields it: any case, with or without a trailing
 * dot, an IPv6 literal with or without its brackets, no port. The URLs the engines see are
 * canonical, so an IPv4 literal is dotted decimal (`0x7f.1` has become `127.0.0.1` by then).
 * Anything unparsable is unique, so a malformed host is still upgraded rather than quietly
 * left over plaintext. The Kotlin twin is `privacy/NonUniqueHost.kt`; `nonUniqueHostTables`
 * exposes the tables so a test holds the two to each other.
 */

// BEGIN NON_REGISTRABLE_SUFFIXES (mirrored by NonUniqueHost.kt)
/**
 * Suffixes (and bare names) no registry delegates; a host under one has no public identity.
 * The special-use names local networks are given (RFC 6761/8375 and the common private ones),
 * not `.example`: that one is reserved for documentation and names no network, and the test
 * suites use it as their stand-in for public sites.
 */
const NON_REGISTRABLE_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'test',
  'invalid',
  'home.arpa',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
  'localdomain'
]
// END NON_REGISTRABLE_SUFFIXES

// BEGIN RESERVED_IPV4 (mirrored by NonUniqueHost.kt)
/** IPv4 blocks that are not publicly routable (the IANA special-purpose registry). */
const RESERVED_IPV4: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4'
]
// END RESERVED_IPV4

// BEGIN RESERVED_IPV6 (mirrored by NonUniqueHost.kt)
/** IPv6 blocks that are not publicly routable; the two IPv4-carrying prefixes are handled apart. */
const RESERVED_IPV6: readonly string[] = [
  '::/128',
  '::1/128',
  '100::/64',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8'
]
// END RESERVED_IPV6

// BEGIN IPV4_CARRIER_IPV6 (mirrored by NonUniqueHost.kt)
/** Prefixes whose last four bytes are an IPv4 address the answer comes from (mapped, NAT64). */
const IPV4_CARRIER_IPV6: readonly string[] = ['::ffff:0:0/96', '64:ff9b::/96']
// END IPV4_CARRIER_IPV6

/** A canonical hostname: dot-separated labels of letters, digits, `-` and `_` (IDN in punycode). */
const HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/

type Block = readonly [prefix: Uint8Array, bits: number]

/** The tables, exposed so a test can hold the Kotlin mirror to them. */
export function nonUniqueHostTables(): {
  suffixes: string[]
  ipv4: string[]
  ipv6: string[]
  ipv4Carriers: string[]
} {
  return {
    suffixes: [...NON_REGISTRABLE_SUFFIXES],
    ipv4: [...RESERVED_IPV4],
    ipv6: [...RESERVED_IPV6],
    ipv4Carriers: [...IPV4_CARRIER_IPV6]
  }
}

/**
 * Whether `host` is a non-unique hostname: loopback, a non-publicly-routable IP literal, or a
 * name without a registrable suffix. Chrome's HTTPS-First mode skips such hosts; so does Zenium's.
 */
export function isNonUniqueHost(host: string): boolean {
  let name = host.trim().toLowerCase()
  if (name.endsWith('.') && name.length > 1) name = name.slice(0, -1)
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1)
  if (!name) return false
  const v4 = parseIpv4(name)
  if (v4) return isReservedIpv4(v4)
  const v6 = parseIpv6(name)
  if (v6) return isReservedIpv6(v6)
  if (!HOSTNAME.test(name)) return false
  return (
    !name.includes('.') || NON_REGISTRABLE_SUFFIXES.some((suffix) => name.endsWith(`.${suffix}`))
  )
}

const IPV4_BLOCKS: readonly Block[] = RESERVED_IPV4.map((cidr) => block(cidr, parseIpv4))
const IPV6_BLOCKS: readonly Block[] = RESERVED_IPV6.map((cidr) => block(cidr, parseIpv6))
const CARRIER_BLOCKS: readonly Block[] = IPV4_CARRIER_IPV6.map((cidr) => block(cidr, parseIpv6))

function block(cidr: string, parse: (text: string) => Uint8Array | null): Block {
  const slash = cidr.indexOf('/')
  const prefix = parse(cidr.slice(0, slash))
  if (!prefix) throw new Error(`Malformed address block ${cidr}`)
  return [prefix, Number(cidr.slice(slash + 1))]
}

function isReservedIpv4(address: Uint8Array): boolean {
  return IPV4_BLOCKS.some(([prefix, bits]) => inBlock(address, prefix, bits))
}

function isReservedIpv6(address: Uint8Array): boolean {
  for (const [prefix, bits] of CARRIER_BLOCKS)
    if (inBlock(address, prefix, bits)) return isReservedIpv4(address.subarray(12))
  return IPV6_BLOCKS.some(([prefix, bits]) => inBlock(address, prefix, bits))
}

/** Whether `address` lies in the block of `prefix` with `bits` significant bits. */
function inBlock(address: Uint8Array, prefix: Uint8Array, bits: number): boolean {
  if (address.length !== prefix.length) return false
  const whole = bits >> 3
  for (let i = 0; i < whole; i++) if (address[i] !== prefix[i]) return false
  const rest = bits & 7
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (address[whole] & mask) === (prefix[whole] & mask)
}

/** Dotted-decimal IPv4 (`192.168.0.1`): four octets in range; anything else is not an address. */
export function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = parts[i]
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    out[i] = value
  }
  return out
}

/**
 * RFC 4291 text (`::1`, `fe80::1%eth0` without its zone, `::ffff:192.168.0.1`), one `::` at
 * most, to sixteen bytes; anything else is not an address.
 */
export function parseIpv6(text: string): Uint8Array | null {
  const zone = text.indexOf('%')
  const literal = zone === -1 ? text : text.slice(0, zone)
  if (!/^[0-9a-f:.]+$/i.test(literal) || !literal.includes(':')) return null
  const gap = literal.indexOf('::')
  if (gap !== -1 && literal.indexOf('::', gap + 1) !== -1) return null
  const head = gap === -1 ? literal : literal.slice(0, gap)
  const tail = gap === -1 ? '' : literal.slice(gap + 2)
  const headGroups = groups(head)
  const tailGroups = groups(tail)
  if (!headGroups || !tailGroups) return null
  const given = headGroups.length + tailGroups.length
  if (gap === -1 ? given !== 8 : given > 7) return null
  const filled = [...headGroups, ...new Array<number>(8 - given).fill(0), ...tailGroups]
  const out = new Uint8Array(16)
  filled.forEach((group, i) => {
    out[i * 2] = group >> 8
    out[i * 2 + 1] = group & 0xff
  })
  return out
}

/** The 16-bit groups of one side of a `::`; an embedded dotted IPv4 (last only) counts as two. */
function groups(side: string): number[] | null {
  if (side === '') return []
  const out: number[] = []
  const parts = side.split(':')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.includes('.')) {
      if (i !== parts.length - 1) return null
      const v4 = parseIpv4(part)
      if (!v4) return null
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    out.push(parseInt(part, 16))
  }
  return out
}
