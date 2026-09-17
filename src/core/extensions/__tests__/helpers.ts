/**
 * Test-only builders: a zip writer and a CRX3 packer. They deliberately use Node's crypto and zlib
 * (independent implementations of what the core decodes with WebCrypto and DecompressionStream)
 * so the tests check interoperability rather than round-tripping through the code under test.
 */
// eslint-disable-next-line no-restricted-imports
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
// eslint-disable-next-line no-restricted-imports
import { deflateRawSync } from 'node:zlib'
import { asBufferSource, concatBytes, utf8Encode } from '../bytes'
import { encodeBytesField } from '../protobuf'
import { crc32 } from '../zip'

// ---------------------------------------------------------------------------
// Zip writer
// ---------------------------------------------------------------------------

export interface ZipInput {
  name: string
  data?: Uint8Array | string
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8
  /** Overrides for corruption tests. */
  crc?: number
  declaredSize?: number
  flags?: number
  /** Raw compression method to write (e.g. 12 for bzip2) instead of a supported one. */
  rawMethod?: number
}

export interface ZipBuildOptions {
  comment?: string
  /** Pretend the archive is zip64 by writing 0xFFFF as the entry count. */
  zip64Count?: boolean
  /** Insert a zip64 end-of-central-directory locator before the EOCD. */
  zip64Locator?: boolean
  /** Append junk after the EOCD (trailing padding). */
  trailing?: Uint8Array
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value, true)
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, true)
  return out
}

export function buildZip(inputs: ZipInput[], options: ZipBuildOptions = {}): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const input of inputs) {
    const nameBytes = utf8Encode(input.name)
    const raw =
      input.data === undefined
        ? new Uint8Array(0)
        : typeof input.data === 'string'
          ? utf8Encode(input.data)
          : input.data
    const method = input.method ?? 8
    const stored = method === 0 ? raw : new Uint8Array(deflateRawSync(raw))
    const crc = input.crc ?? crc32(raw)
    const size = input.declaredSize ?? raw.length
    const flags = input.flags ?? 0x0800
    const writtenMethod = input.rawMethod ?? method
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(writtenMethod),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(stored.length),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      stored
    ])
    const central = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(flags),
      u16(writtenMethod),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(stored.length),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(input.name.endsWith('/') ? 0x10 : 0),
      u32(offset),
      nameBytes
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralStart = offset
  const centralBytes = concatBytes(centrals)
  const comment = utf8Encode(options.comment ?? '')
  const count = options.zip64Count ? 0xffff : inputs.length
  const locator = options.zip64Locator
    ? concatBytes([u32(0x07064b50), u32(0), u32(0), u32(0), u32(1)])
    : new Uint8Array(0)
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(centralBytes.length),
    u32(centralStart),
    u16(comment.length),
    comment
  ])
  return concatBytes([
    ...locals,
    centralBytes,
    locator,
    eocd,
    options.trailing ?? new Uint8Array(0)
  ])
}

// ---------------------------------------------------------------------------
// CRX3 packer
// ---------------------------------------------------------------------------

export interface TestKeyPair {
  publicKey: KeyObject
  privateKey: KeyObject
  /** DER SubjectPublicKeyInfo. */
  spki: Uint8Array
}

export function generateRsaKey(modulusLength = 2048): TestKeyPair {
  const pair = generateKeyPairSync('rsa', { modulusLength })
  return {
    ...pair,
    spki: new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }))
  }
}

export function generateEcKey(namedCurve = 'prime256v1'): TestKeyPair {
  const pair = generateKeyPairSync('ec', { namedCurve })
  return {
    ...pair,
    spki: new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }))
  }
}

export interface CrxBuildOptions {
  zip: Uint8Array
  /** RSA keys; the first is the developer key unless `crxId` says otherwise. */
  rsaKeys: TestKeyPair[]
  /** ECDSA P-256 keys (signatures are DER, as Chrome writes them). */
  ecdsaKeys?: TestKeyPair[]
  /** The 16 raw bytes to declare; defaults to the first RSA key's id. */
  crxId?: Uint8Array
  /** Overrides for corruption tests. */
  magic?: string
  version?: number
  headerLengthOverride?: number
  /** Replace the protobuf header with these bytes. */
  headerOverride?: Uint8Array
  /** Extra raw fields appended to the header (e.g. unknown field numbers). */
  extraHeaderFields?: Uint8Array[]
}

async function sha256Prefix(spki: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', asBufferSource(spki))
  return new Uint8Array(digest).subarray(0, 16)
}

function signRsa(key: TestKeyPair, message: Uint8Array): Uint8Array {
  const signer = createSign('RSA-SHA256')
  signer.update(message)
  return new Uint8Array(signer.sign(key.privateKey))
}

function signEcdsaDer(key: TestKeyPair, message: Uint8Array): Uint8Array {
  const signer = createSign('SHA256')
  signer.update(message)
  return new Uint8Array(signer.sign({ key: key.privateKey, dsaEncoding: 'der' }))
}

/** Packs a CRX3 exactly as Chrome's `crx3` writer lays it out. */
export async function buildCrx(options: CrxBuildOptions): Promise<Uint8Array> {
  const crxId = options.crxId ?? (await sha256Prefix(options.rsaKeys[0].spki))
  const signedHeaderData = encodeBytesField(1, crxId)
  const lengthPrefix = new Uint8Array(4)
  new DataView(lengthPrefix.buffer).setUint32(0, signedHeaderData.length, true)
  const message = concatBytes([
    utf8Encode('CRX3 SignedData\0'),
    lengthPrefix,
    signedHeaderData,
    options.zip
  ])
  const fields: Uint8Array[] = []
  for (const key of options.rsaKeys) {
    const proof = concatBytes([
      encodeBytesField(1, key.spki),
      encodeBytesField(2, signRsa(key, message))
    ])
    fields.push(encodeBytesField(2, proof))
  }
  for (const key of options.ecdsaKeys ?? []) {
    const proof = concatBytes([
      encodeBytesField(1, key.spki),
      encodeBytesField(2, signEcdsaDer(key, message))
    ])
    fields.push(encodeBytesField(3, proof))
  }
  fields.push(...(options.extraHeaderFields ?? []))
  fields.push(encodeBytesField(10000, signedHeaderData))
  const header = options.headerOverride ?? concatBytes(fields)
  const prelude = new Uint8Array(12)
  prelude.set(utf8Encode(options.magic ?? 'Cr24'), 0)
  const view = new DataView(prelude.buffer)
  view.setUint32(4, options.version ?? 3, true)
  view.setUint32(8, options.headerLengthOverride ?? header.length, true)
  return concatBytes([prelude, header, options.zip])
}

/** A minimal, valid extension archive to wrap in CRX tests. */
export function sampleExtensionZip(manifest: Record<string, unknown> = {}): Uint8Array {
  return buildZip([
    {
      name: 'manifest.json',
      data: JSON.stringify({
        manifest_version: 3,
        name: 'Sample',
        version: '1.0.0',
        ...manifest
      })
    },
    { name: 'background.js', data: 'console.log("hi")' }
  ])
}
