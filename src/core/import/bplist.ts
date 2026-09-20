/**
 * Apple's binary property list (`bplist00`), the format of Safari's `Bookmarks.plist`: a header,
 * the objects (each a marker byte with its type in the high nibble and a small count in the
 * low one, longer counts as a following integer), an offset table and a 32-byte trailer that
 * says how wide offsets and object references are and which object is the root.
 */

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue }

export type PlistDict = { [key: string]: PlistValue }

const HEADER = 'bplist0'
/** A guard against a reference cycle or a hostile file; Safari's bookmarks nest a handful deep. */
const MAX_DEPTH = 64

export function isBinaryPlist(bytes: Uint8Array): boolean {
  if (bytes.length < 40) return false
  for (let i = 0; i < HEADER.length; i++) if (bytes[i] !== HEADER.charCodeAt(i)) return false
  return true
}

export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (!isBinaryPlist(bytes)) throw new Error('Not a binary property list.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const trailer = bytes.length - 32
  const offsetIntSize = bytes[trailer + 6]
  const objectRefSize = bytes[trailer + 7]
  const numObjects = readUIntBE(view, trailer + 8, 8)
  const topObject = readUIntBE(view, trailer + 16, 8)
  const offsetTableOffset = readUIntBE(view, trailer + 24, 8)
  if (
    offsetIntSize < 1 ||
    offsetIntSize > 8 ||
    objectRefSize < 1 ||
    objectRefSize > 8 ||
    offsetTableOffset + numObjects * offsetIntSize > trailer ||
    topObject >= numObjects
  )
    throw new Error('The property list trailer is malformed.')

  const offsets: number[] = []
  for (let i = 0; i < numObjects; i++)
    offsets.push(readUIntBE(view, offsetTableOffset + i * offsetIntSize, offsetIntSize))

  const fail = (): never => {
    throw new Error('The property list is malformed.')
  }

  const readCount = (marker: number, at: number): { count: number; next: number } => {
    const low = marker & 0x0f
    if (low !== 0x0f) return { count: low, next: at + 1 }
    const intMarker = bytes[at + 1]
    if ((intMarker & 0xf0) !== 0x10) fail()
    const size = 1 << (intMarker & 0x0f)
    return { count: readUIntBE(view, at + 2, size), next: at + 2 + size }
  }

  const parse = (index: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH || index >= offsets.length) fail()
    const at = offsets[index]
    if (at >= trailer) fail()
    const marker = bytes[at]
    const type = marker & 0xf0
    switch (type) {
      case 0x00:
        if (marker === 0x00 || marker === 0x0f) return null
        if (marker === 0x08) return false
        if (marker === 0x09) return true
        return fail()
      case 0x10: {
        const size = 1 << (marker & 0x0f)
        if (size === 16) return Number(readBigIntBE(view, at + 1, 16))
        if (size === 8) return Number(view.getBigInt64(at + 1))
        return readUIntBE(view, at + 1, size)
      }
      case 0x20: {
        const size = 1 << (marker & 0x0f)
        if (size === 4) return view.getFloat32(at + 1)
        if (size === 8) return view.getFloat64(at + 1)
        return fail()
      }
      case 0x30:
        // Seconds since 2001-01-01 as a float64.
        return new Date((view.getFloat64(at + 1) + 978_307_200) * 1000)
      case 0x40: {
        const { count, next } = readCount(marker, at)
        return bytes.slice(next, next + count)
      }
      case 0x50: {
        const { count, next } = readCount(marker, at)
        let s = ''
        for (let i = 0; i < count; i++) s += String.fromCharCode(bytes[next + i])
        return s
      }
      case 0x60: {
        const { count, next } = readCount(marker, at)
        const codes: number[] = []
        for (let i = 0; i < count; i++) codes.push(view.getUint16(next + 2 * i))
        return String.fromCharCode(...codes)
      }
      case 0x70: {
        // UTF-8 strings (bplist01); the count is in bytes.
        const { count, next } = readCount(marker, at)
        return new TextDecoder().decode(bytes.subarray(next, next + count))
      }
      case 0x80: {
        const size = (marker & 0x0f) + 1
        return readUIntBE(view, at + 1, size)
      }
      case 0xa0:
      case 0xc0: {
        const { count, next } = readCount(marker, at)
        const list: PlistValue[] = []
        for (let i = 0; i < count; i++)
          list.push(parse(readUIntBE(view, next + i * objectRefSize, objectRefSize), depth + 1))
        return list
      }
      case 0xd0: {
        const { count, next } = readCount(marker, at)
        const dict: PlistDict = {}
        for (let i = 0; i < count; i++) {
          const key = parse(readUIntBE(view, next + i * objectRefSize, objectRefSize), depth + 1)
          const value = parse(
            readUIntBE(view, next + (count + i) * objectRefSize, objectRefSize),
            depth + 1
          )
          if (typeof key === 'string') dict[key] = value
        }
        return dict
      }
      default:
        return fail()
    }
  }
  return parse(topObject, 0)
}

function readUIntBE(view: DataView, at: number, size: number): number {
  if (at + size > view.byteLength) throw new Error('The property list is truncated.')
  switch (size) {
    case 1:
      return view.getUint8(at)
    case 2:
      return view.getUint16(at)
    case 4:
      return view.getUint32(at)
    case 8:
      return Number(view.getBigUint64(at))
    default: {
      let n = 0
      for (let i = 0; i < size; i++) n = n * 256 + view.getUint8(at + i)
      return n
    }
  }
}

function readBigIntBE(view: DataView, at: number, size: number): bigint {
  let n = 0n
  for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(view.getUint8(at + i))
  return n
}

export function plistDict(value: PlistValue): PlistDict | null {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date)
    ? (value as PlistDict)
    : null
}

export function plistString(value: PlistValue | undefined): string {
  return typeof value === 'string' ? value : ''
}
