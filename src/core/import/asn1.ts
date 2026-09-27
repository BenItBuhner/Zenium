/**
 * A minimal DER reader for the shapes NSS wraps Firefox's key store in (`firefoxLogins.ts`):
 * SEQUENCE, OCTET STRING, OBJECT IDENTIFIER, INTEGER and NULL. Not a general ASN.1 library –
 * it decodes definite-length DER far enough to walk `key4.db`'s PBE algorithm identifiers and a
 * `logins.json` blob's 3DES parameters, and it treats every malformed input as a typed
 * `Asn1Error` rather than letting a `RangeError` escape, so a corrupt profile fails cleanly.
 */

export class Asn1Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Asn1Error'
  }
}

export const TAG_INTEGER = 0x02
export const TAG_BIT_STRING = 0x03
export const TAG_OCTET_STRING = 0x04
export const TAG_NULL = 0x05
export const TAG_OID = 0x06
export const TAG_SEQUENCE = 0x30
export const TAG_SET = 0x31

/** `0x20` in a tag marks a constructed value (its content is more TLVs). */
const CONSTRUCTED = 0x20
/** DER nests only a handful deep; a runaway depth is malformed input, not a value to follow. */
const MAX_DEPTH = 32

export interface Asn1Node {
  readonly tag: number
  /** The value octets (the `V` of the `TLV`); for a constructed node, the concatenated children. */
  readonly content: Uint8Array
  /** Parsed elements of a constructed node (SEQUENCE / SET); empty for primitives. */
  readonly children: Asn1Node[]
}

function readNode(
  bytes: Uint8Array,
  start: number,
  depth: number
): { node: Asn1Node; end: number } {
  if (depth > MAX_DEPTH) throw new Asn1Error('value nested too deeply')
  if (start >= bytes.length) throw new Asn1Error('truncated: no tag')
  const tag = bytes[start]
  let pos = start + 1
  if (pos >= bytes.length) throw new Asn1Error('truncated: no length')
  let length = bytes[pos++]
  if (length === 0x80) throw new Asn1Error('indefinite length is not DER')
  if ((length & 0x80) !== 0) {
    const width = length & 0x7f
    if (width > 4) throw new Asn1Error('length is too large')
    if (pos + width > bytes.length) throw new Asn1Error('truncated: length octets')
    length = 0
    for (let i = 0; i < width; i++) length = length * 256 + bytes[pos++]
  }
  const end = pos + length
  if (end > bytes.length || end < pos) throw new Asn1Error('content runs past the end')
  const content = bytes.subarray(pos, end)
  const children: Asn1Node[] = []
  if ((tag & CONSTRUCTED) !== 0) {
    let inner = 0
    while (inner < content.length) {
      const child = readNode(content, inner, depth + 1)
      children.push(child.node)
      inner = child.end
    }
  }
  return { node: { tag, content, children }, end }
}

/** Decode exactly one DER value; trailing bytes after it are malformed. */
export function decodeDer(bytes: Uint8Array): Asn1Node {
  if (!(bytes instanceof Uint8Array)) throw new Asn1Error('expected bytes')
  const { node, end } = readNode(bytes, 0, 0)
  if (end !== bytes.length) throw new Asn1Error('trailing bytes after the value')
  return node
}

/** A constructed node's elements; throws unless the node is a SEQUENCE. */
export function sequenceOf(node: Asn1Node): Asn1Node[] {
  if (node.tag !== TAG_SEQUENCE) throw new Asn1Error(`expected SEQUENCE, got 0x${hex(node.tag)}`)
  return node.children
}

/** The `index`-th element of a node, or a typed error when it is missing. */
export function childAt(node: Asn1Node, index: number): Asn1Node {
  const child = node.children[index]
  if (!child) throw new Asn1Error(`missing element ${index}`)
  return child
}

export function octetsOf(node: Asn1Node): Uint8Array {
  if (node.tag !== TAG_OCTET_STRING)
    throw new Asn1Error(`expected OCTET STRING, got 0x${hex(node.tag)}`)
  return node.content
}

export function oidOf(node: Asn1Node): string {
  if (node.tag !== TAG_OID)
    throw new Asn1Error(`expected OBJECT IDENTIFIER, got 0x${hex(node.tag)}`)
  const bytes = node.content
  if (bytes.length === 0) throw new Asn1Error('empty OBJECT IDENTIFIER')
  const first = bytes[0]
  const lead = first < 40 ? 0 : first < 80 ? 1 : 2
  const arcs: number[] = [lead, first - lead * 40]
  let value = 0
  let pending = false
  for (let i = 1; i < bytes.length; i++) {
    const b = bytes[i]
    value = value * 128 + (b & 0x7f)
    if (!Number.isSafeInteger(value)) throw new Asn1Error('OID arc is too large')
    pending = (b & 0x80) !== 0
    if (!pending) {
      arcs.push(value)
      value = 0
    }
  }
  if (pending) throw new Asn1Error('truncated OID arc')
  return arcs.join('.')
}

/** A (possibly large) INTEGER as a bigint, two's complement as DER encodes it. */
export function integerOf(node: Asn1Node): bigint {
  if (node.tag !== TAG_INTEGER) throw new Asn1Error(`expected INTEGER, got 0x${hex(node.tag)}`)
  const bytes = node.content
  if (bytes.length === 0) throw new Asn1Error('empty INTEGER')
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  if ((bytes[0] & 0x80) !== 0) value -= 1n << BigInt(bytes.length * 8)
  return value
}

/** A small INTEGER as a number (iteration counts, key lengths); throws when it will not fit. */
export function intOf(node: Asn1Node): number {
  const value = integerOf(node)
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Asn1Error('INTEGER does not fit in a number')
  return Number(value)
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}
