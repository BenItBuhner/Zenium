import { describe, expect, it } from 'vitest'
import {
  Asn1Error,
  TAG_OCTET_STRING,
  TAG_SEQUENCE,
  childAt,
  decodeDer,
  integerOf,
  intOf,
  octetsOf,
  oidOf,
  sequenceOf
} from '../asn1'
import { derInt, derNull, derOctet, derOid, derSeq } from './firefoxFixtures'

describe('asn1: DER reader', () => {
  it('walks a SEQUENCE of an OID, an OCTET STRING, an INTEGER and NULL', () => {
    const bytes = derSeq(
      derOid('1.2.840.113549.1.5.13'),
      derOctet(Uint8Array.of(1, 2, 3, 4)),
      derInt(10000),
      derNull()
    )
    const node = decodeDer(bytes)
    const [oid, octets, integer, nul] = sequenceOf(node)
    expect(node.tag).toBe(TAG_SEQUENCE)
    expect(oidOf(oid)).toBe('1.2.840.113549.1.5.13')
    expect(octets.tag).toBe(TAG_OCTET_STRING)
    expect([...octetsOf(octets)]).toEqual([1, 2, 3, 4])
    expect(intOf(integer)).toBe(10000)
    expect(nul.tag).toBe(0x05)
  })

  it('decodes the OIDs and IVs the Firefox key store uses', () => {
    expect(oidOf(decodeDer(derOid('2.16.840.1.101.3.4.1.42')))).toBe('2.16.840.1.101.3.4.1.42')
    expect(oidOf(decodeDer(derOid('1.2.840.113549.3.7')))).toBe('1.2.840.113549.3.7')
    expect(oidOf(decodeDer(derOid('1.2.840.113549.1.12.5.1.3')))).toBe('1.2.840.113549.1.12.5.1.3')
  })

  it('reads long-form lengths and large integers', () => {
    const long = derOctet(new Uint8Array(300).fill(0xab))
    expect([...octetsOf(decodeDer(long))]).toHaveLength(300)
    // 2^53 - 1 as a bigint through the raw INTEGER encoding.
    const big = decodeDer(Uint8Array.of(0x02, 0x07, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))
    expect(integerOf(big)).toBe(9007199254740991n)
  })

  it('treats every malformed input as a typed Asn1Error, never a raw throw', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0), // nothing
      Uint8Array.of(0x30), // tag with no length
      Uint8Array.of(0x30, 0x05, 0x01), // content runs past the end
      Uint8Array.of(0x04, 0x80), // indefinite length
      Uint8Array.of(0x04, 0x85, 0, 0, 0, 0, 0), // length octets too wide
      Uint8Array.of(0x04, 0x01, 0x01, 0x99), // trailing byte after the value
      Uint8Array.of(0x06, 0x02, 0x88, 0x88) // truncated final OID arc
    ]
    for (const bytes of cases) {
      let thrown: unknown
      try {
        const node = decodeDer(bytes)
        oidOf(node)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Asn1Error)
    }
  })

  it('rejects deep nesting instead of overflowing the stack', () => {
    let bytes = derOctet(Uint8Array.of(1))
    for (let i = 0; i < 200; i++) bytes = derSeq(bytes)
    expect(() => decodeDer(bytes)).toThrow(Asn1Error)
  })

  it('reports the wrong tag through its typed accessors', () => {
    const octets = decodeDer(derOctet(Uint8Array.of(1)))
    expect(() => sequenceOf(octets)).toThrow(Asn1Error)
    expect(() => oidOf(octets)).toThrow(Asn1Error)
    expect(() => integerOf(octets)).toThrow(Asn1Error)
    expect(() => childAt(octets, 0)).toThrow(Asn1Error)
  })
})
