import { beforeAll, describe, expect, it } from 'vitest'
import {
  base64Decode,
  concatBytes,
  extensionIdFromPublicKey,
  sha256,
  toHex,
  utf8Encode
} from '../bytes'
import {
  CrxError,
  PUBLISHER_KEY_HASHES,
  ecdsaDerToRaw,
  identifyPublisher,
  parseCrxHeader,
  verifyCrx
} from '../crx'
import { encodeBytesField, encodeVarint } from '../protobuf'
import {
  CWS_VIMIUM_HEADER_BASE64,
  CWS_VIMIUM_ID,
  EDGE_CLEARURLS_HEADER_BASE64,
  EDGE_CLEARURLS_ID
} from './fixtures'
import {
  buildCrx,
  generateEcKey,
  generateRsaKey,
  sampleExtensionZip,
  type TestKeyPair
} from './helpers'

let developer: TestKeyPair
let storeRsa: TestKeyPair
let storeEc: TestKeyPair
let zip: Uint8Array

beforeAll(() => {
  developer = generateRsaKey(2048)
  storeRsa = generateRsaKey(2048)
  storeEc = generateEcKey()
  zip = sampleExtensionZip()
})

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

async function expectCrxError(promise: Promise<unknown>, code: CrxError['code']): Promise<void> {
  let caught: unknown = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(CrxError)
  expect((caught as CrxError).code).toBe(code)
}

describe('CRX3 verification', () => {
  it('verifies a freshly packed CRX signed by an RSA developer key', async () => {
    const crx = await buildCrx({ zip, rsaKeys: [developer] })
    const result = await verifyCrx(crx)
    expect(result.id).toBe(await extensionIdFromPublicKey(developer.spki))
    expect(result.id).toMatch(/^[a-p]{32}$/)
    expect(result.publicKey).toEqual(developer.spki)
    expect(result.publisher).toBe('unknown')
    expect(result.zipOffset).toBe(crx.length - zip.length)
    expect(result.zip).toEqual(zip)
    expect(result.verifiedKeyHashes).toEqual([toHex(await sha256(developer.spki))])
  })

  it('verifies every extra RSA and ECDSA (DER-signed) proof a store might add', async () => {
    // Store key first, as the Chrome Web Store lays it out; crx_id still names the developer.
    const crx = await buildCrx({
      zip,
      rsaKeys: [storeRsa, developer],
      ecdsaKeys: [storeEc],
      crxId: (await sha256(developer.spki)).subarray(0, 16)
    })
    const result = await verifyCrx(crx)
    expect(result.id).toBe(await extensionIdFromPublicKey(developer.spki))
    expect(result.publicKey).toEqual(developer.spki)
    expect(result.verifiedKeyHashes).toHaveLength(3)
    // Test keys are not store keys.
    expect(result.publisher).toBe('unknown')
  })

  it('rejects an archive with a single flipped byte', async () => {
    const crx = await buildCrx({ zip, rsaKeys: [developer], ecdsaKeys: [storeEc] })
    const tampered = new Uint8Array(crx)
    tampered[tampered.length - 40] ^= 0x01
    await expectCrxError(verifyCrx(tampered), 'bad-signature')
  })

  it('rejects a tampered signature even when the archive is intact', async () => {
    const crx = await buildCrx({ zip, rsaKeys: [developer] })
    const signature = parseCrxHeader(crx).proofs[0].signature
    const signatureOffset = findSubarray(crx, signature)
    expect(signatureOffset).toBeGreaterThan(12)
    const tampered = new Uint8Array(crx)
    tampered[signatureOffset + 10] ^= 0x80
    await expectCrxError(verifyCrx(tampered), 'bad-signature')
  })

  it('rejects a crx_id that no RSA key derives', async () => {
    const crx = await buildCrx({
      zip,
      rsaKeys: [developer],
      crxId: new Uint8Array(16).fill(0xab)
    })
    await expectCrxError(verifyCrx(crx), 'id-mismatch')
    // Structure is fine, only the binding is wrong.
    expect(parseCrxHeader(crx).declaredId).toBe('kl'.repeat(16))
  })

  it('rejects a package whose only key is ECDSA', async () => {
    const ecId = (await sha256(storeEc.spki)).subarray(0, 16)
    const crx = await buildCrx({ zip, rsaKeys: [], ecdsaKeys: [storeEc], crxId: ecId })
    await expectCrxError(verifyCrx(crx), 'id-mismatch')
  })

  it('rejects a non-P-256 ECDSA key', async () => {
    const p384 = generateEcKey('secp384r1')
    const crx = await buildCrx({ zip, rsaKeys: [developer], ecdsaKeys: [p384] })
    await expectCrxError(verifyCrx(crx), 'unsupported-key')
  })

  it('rejects bad magic, CRX2, oversize and truncated headers', async () => {
    await expectCrxError(
      verifyCrx(await buildCrx({ zip, rsaKeys: [developer], magic: 'Cr23' })),
      'bad-magic'
    )
    await expectCrxError(
      verifyCrx(await buildCrx({ zip, rsaKeys: [developer], version: 2 })),
      'unsupported-version'
    )
    await expectCrxError(
      verifyCrx(await buildCrx({ zip, rsaKeys: [developer], headerLengthOverride: 100_000 })),
      'truncated'
    )
    const big = await buildCrx({ zip, rsaKeys: [developer] })
    await expectCrxError(verifyCrx(big, { maxHeaderLength: 100 }), 'header-too-large')
    await expectCrxError(verifyCrx(new Uint8Array([0x43, 0x72, 0x32, 0x34, 3, 0])), 'truncated')
  })

  it('rejects malformed protobuf headers and headers without proofs', async () => {
    const garbage = await buildCrx({
      zip,
      rsaKeys: [developer],
      headerOverride: new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff])
    })
    await expectCrxError(verifyCrx(garbage), 'malformed-header')

    const noSignedData = await buildCrx({
      zip,
      rsaKeys: [developer],
      headerOverride: encodeBytesField(2, encodeBytesField(1, developer.spki))
    })
    await expectCrxError(verifyCrx(noSignedData), 'malformed-header')

    const onlySignedData = await buildCrx({
      zip,
      rsaKeys: [developer],
      headerOverride: encodeBytesField(10000, encodeBytesField(1, new Uint8Array(16)))
    })
    await expectCrxError(verifyCrx(onlySignedData), 'no-proofs')

    const bogusProof = concatBytes([
      encodeBytesField(1, developer.spki),
      encodeBytesField(2, new Uint8Array([1]))
    ])
    const shortId = await buildCrx({
      zip,
      rsaKeys: [developer],
      headerOverride: concatBytes([
        encodeBytesField(2, bogusProof),
        encodeBytesField(10000, encodeBytesField(1, new Uint8Array(15)))
      ])
    })
    await expectCrxError(verifyCrx(shortId), 'malformed-header')

    const proofWithoutSignature = await buildCrx({
      zip,
      rsaKeys: [developer],
      headerOverride: concatBytes([
        encodeBytesField(2, encodeBytesField(1, developer.spki)),
        encodeBytesField(10000, encodeBytesField(1, new Uint8Array(16)))
      ])
    })
    await expectCrxError(verifyCrx(proofWithoutSignature), 'malformed-header')
  })

  it('skips unknown header fields (forward compatibility)', async () => {
    const crx = await buildCrx({
      zip,
      rsaKeys: [developer],
      extraHeaderFields: [
        encodeBytesField(4, utf8Encode('verified_contents')),
        new Uint8Array([0x28, ...encodeVarint(300)]) // field 5, varint
      ]
    })
    const result = await verifyCrx(crx)
    expect(result.id).toBe(await extensionIdFromPublicKey(developer.spki))
  })
})

describe('ECDSA DER to raw conversion', () => {
  it('pads short integers and strips the leading zero of high-bit integers', () => {
    const r = new Uint8Array(31).fill(0x11)
    const s = new Uint8Array([0x80, ...new Array<number>(31).fill(0x22)])
    const der = new Uint8Array([0x30, 2 + 31 + 2 + 33, 0x02, 31, ...r, 0x02, 33, 0x00, ...s])
    const raw = ecdsaDerToRaw(der)
    expect(raw.length).toBe(64)
    expect(raw[0]).toBe(0)
    expect(raw.subarray(1, 32)).toEqual(r)
    expect(raw.subarray(32)).toEqual(s)
  })

  it('rejects malformed DER', () => {
    expect(() => ecdsaDerToRaw(new Uint8Array([0x31, 0x00]))).toThrow(CrxError)
    expect(() => ecdsaDerToRaw(new Uint8Array([0x30, 0x04, 0x02, 0x01, 0x01]))).toThrow(CrxError)
    const tooBig = new Uint8Array([
      0x30,
      0x25,
      0x02,
      0x21,
      0x01,
      ...new Array<number>(32).fill(0),
      0x02,
      0x00
    ])
    expect(() => ecdsaDerToRaw(tooBig)).toThrow(/too large/)
  })
})

describe('real store headers (fixtures)', () => {
  it('parses a Chrome Web Store header and finds the developer and publisher keys', async () => {
    const header = parseCrxHeader(base64Decode(CWS_VIMIUM_HEADER_BASE64))
    expect(header.declaredId).toBe(CWS_VIMIUM_ID)
    expect(header.headerLength).toBe(1048)
    expect(header.proofs.map((p) => p.algorithm)).toEqual([
      'sha256_with_rsa',
      'sha256_with_rsa',
      'sha256_with_ecdsa'
    ])
    const ids = await Promise.all(header.proofs.map((p) => extensionIdFromPublicKey(p.publicKey)))
    expect(ids).toContain(CWS_VIMIUM_ID)
    const hashes = await Promise.all(
      header.proofs.map(async (p) => toHex(await sha256(p.publicKey)))
    )
    const nonDeveloper = hashes.filter((_, i) => ids[i] !== CWS_VIMIUM_ID)
    expect(nonDeveloper).toHaveLength(2)
    expect(identifyPublisher(nonDeveloper)).toBe('chrome-web-store')
    for (const hash of nonDeveloper) expect(PUBLISHER_KEY_HASHES.get(hash)).toBe('chrome-web-store')
  })

  it('parses an Edge Add-ons header and identifies its publisher keys', async () => {
    const header = parseCrxHeader(base64Decode(EDGE_CLEARURLS_HEADER_BASE64))
    expect(header.declaredId).toBe(EDGE_CLEARURLS_ID)
    expect(header.headerLength).toBe(1310)
    const ids = await Promise.all(header.proofs.map((p) => extensionIdFromPublicKey(p.publicKey)))
    const hashes = await Promise.all(
      header.proofs.map(async (p) => toHex(await sha256(p.publicKey)))
    )
    const nonDeveloper = hashes.filter((_, i) => ids[i] !== EDGE_CLEARURLS_ID)
    expect(nonDeveloper).toHaveLength(2)
    expect(identifyPublisher(nonDeveloper)).toBe('edge-add-ons')
  })

  it('cannot verify a header without its archive', async () => {
    await expectCrxError(verifyCrx(base64Decode(CWS_VIMIUM_HEADER_BASE64)), 'bad-signature')
  })
})
