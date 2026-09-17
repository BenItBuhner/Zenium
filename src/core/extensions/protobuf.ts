/**
 * The smallest protobuf wire-format reader that can parse a CRX3 header: varints and
 * length-delimited fields, with the other wire types skipped. No schema, no dependency.
 *
 * Wire types: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. Groups (3, 4) are rejected.
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtobufError'
  }
}

export interface ProtobufField {
  fieldNumber: number
  wireType: 0 | 1 | 2 | 5
  /** Present for wire type 2. */
  bytes?: Uint8Array
  /** Present for wire types 0, 1 and 5 (as an unsigned number; fixed64 only when it fits). */
  value?: number
}

/** Reads a base-128 varint; values above 2^53 are rejected as nothing in CRX needs them. */
export function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0
  let multiplier = 1
  let position = offset
  for (let i = 0; i < 10; i++) {
    if (position >= bytes.length) throw new ProtobufError('Truncated varint')
    const byte = bytes[position++]
    value += (byte & 0x7f) * multiplier
    if (value > Number.MAX_SAFE_INTEGER) throw new ProtobufError('Varint too large')
    if ((byte & 0x80) === 0) return { value, next: position }
    multiplier *= 128
  }
  throw new ProtobufError('Varint longer than 10 bytes')
}

/** Decodes every top-level field of a message; the caller dispatches on `fieldNumber`. */
export function decodeFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = []
  let offset = 0
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset)
    offset = tag.next
    const fieldNumber = Math.floor(tag.value / 8)
    const wireType = tag.value % 8
    if (fieldNumber === 0) throw new ProtobufError('Field number 0 is reserved')
    switch (wireType) {
      case 0: {
        const v = readVarint(bytes, offset)
        offset = v.next
        fields.push({ fieldNumber, wireType: 0, value: v.value })
        break
      }
      case 1: {
        if (offset + 8 > bytes.length) throw new ProtobufError('Truncated fixed64')
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
        const lo = view.getUint32(0, true)
        const hi = view.getUint32(4, true)
        fields.push({ fieldNumber, wireType: 1, value: hi * 0x1_0000_0000 + lo })
        offset += 8
        break
      }
      case 2: {
        const len = readVarint(bytes, offset)
        offset = len.next
        if (offset + len.value > bytes.length) {
          throw new ProtobufError('Length-delimited field exceeds message')
        }
        fields.push({
          fieldNumber,
          wireType: 2,
          bytes: bytes.subarray(offset, offset + len.value)
        })
        offset += len.value
        break
      }
      case 5: {
        if (offset + 4 > bytes.length) throw new ProtobufError('Truncated fixed32')
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
        fields.push({ fieldNumber, wireType: 5, value: view.getUint32(0, true) })
        offset += 4
        break
      }
      default:
        throw new ProtobufError(`Unsupported wire type ${wireType}`)
    }
  }
  return fields
}

/** Convenience for tests and encoders: a varint. */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0)
    throw new ProtobufError('Varint must be a non-negative integer')
  const out: number[] = []
  let v = value
  do {
    let byte = v % 128
    v = Math.floor(v / 128)
    if (v > 0) byte |= 0x80
    out.push(byte)
  } while (v > 0)
  return Uint8Array.from(out)
}

/** A length-delimited field (wire type 2) with the given field number. */
export function encodeBytesField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const tag = encodeVarint(fieldNumber * 8 + 2)
  const len = encodeVarint(payload.length)
  const out = new Uint8Array(tag.length + len.length + payload.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(payload, tag.length + len.length)
  return out
}
