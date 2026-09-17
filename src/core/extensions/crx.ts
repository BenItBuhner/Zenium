/**
 * CRX3 parsing and signature verification (Chrome's packaged-extension format).
 *
 * Layout: `Cr24` | u32le version (3) | u32le header length | CrxFileHeader (protobuf) | zip.
 *
 *   message CrxFileHeader {
 *     repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *     repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
 *     bytes signed_header_data = 10000;   // a serialized SignedData
 *   }
 *   message AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
 *   message SignedData { bytes crx_id = 1; }
 *
 * Every proof signs `"CRX3 SignedData\0" + u32le(len(signed_header_data)) + signed_header_data +
 * zip`. The extension ID is SHA-256(developer SPKI)[0..16] in the a..p alphabet and must equal
 * `crx_id`; the developer key is always an RSA key, as in Chromium's `crx_verifier.cc`. Stores add
 * further proofs with their own keys (see `PUBLISHER_KEY_HASHES`), which lets us tell a Chrome Web
 * Store or Edge Add-ons package from a self-signed one.
 *
 * Web platform APIs only (WebCrypto, DataView): shared by Electron's main process and Android.
 */
import {
  asBufferSource,
  bytesEqual,
  concatBytes,
  idFromDigestPrefix,
  sha256,
  toHex,
  utf8Encode
} from './bytes'
import { ProtobufError, decodeFields } from './protobuf'

export type CrxErrorCode =
  | 'truncated'
  | 'bad-magic'
  | 'unsupported-version'
  | 'header-too-large'
  | 'malformed-header'
  | 'no-proofs'
  | 'unsupported-key'
  | 'bad-signature'
  | 'id-mismatch'

export class CrxError extends Error {
  constructor(
    readonly code: CrxErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CrxError'
  }
}

export type CrxProofAlgorithm = 'sha256_with_rsa' | 'sha256_with_ecdsa'

export interface CrxProof {
  algorithm: CrxProofAlgorithm
  /** DER SubjectPublicKeyInfo. */
  publicKey: Uint8Array
  /** RSASSA-PKCS1-v1_5 signature, or a DER `ECDSA-Sig-Value` for ECDSA. */
  signature: Uint8Array
}

export interface CrxHeader {
  /** Length of the protobuf header in bytes (excludes the 12-byte fixed prelude). */
  headerLength: number
  /** Where the zip archive starts within the CRX. */
  zipOffset: number
  proofs: CrxProof[]
  signedHeaderData: Uint8Array
  /** The 16 raw bytes of `SignedData.crx_id`. */
  crxId: Uint8Array
  /** `crx_id` in the a..p alphabet. */
  declaredId: string
}

export type CrxPublisher = 'chrome-web-store' | 'edge-add-ons' | 'unknown'

export interface VerifiedCrx {
  /** The extension ID, equal to the declared `crx_id` and derived from `publicKey`. */
  id: string
  /** The developer's DER SPKI public key (what `manifest.key` holds, base64-encoded). */
  publicKey: Uint8Array
  publisher: CrxPublisher
  zipOffset: number
  /** A view (not a copy) of the archive inside the CRX bytes. */
  zip: Uint8Array
  /** SPKI SHA-256 (lowercase hex) of every key whose proof verified, developer key included. */
  verifiedKeyHashes: string[]
}

export interface CrxVerifyOptions {
  /** Upper bound for the protobuf header; real store headers are around 1.3 KB. */
  maxHeaderLength?: number
}

export const CRX3_MAGIC = 'Cr24'
export const CRX3_VERSION = 3
export const DEFAULT_MAX_HEADER_LENGTH = 1024 * 1024

const PRELUDE_LENGTH = 12
const CRX_ID_LENGTH = 16
const FIELD_RSA = 2
const FIELD_ECDSA = 3
const FIELD_SIGNED_HEADER_DATA = 10000
const SIGNATURE_CONTEXT = utf8Encode('CRX3 SignedData\0')

/**
 * SPKI SHA-256 hashes of the keys the stores add to every package they serve. Observed on every
 * Chrome Web Store and Edge Add-ons CRX downloaded while building this module; the Chrome Web
 * Store ECDSA hash is also Chromium's `kPublisherKeyHash` (`components/crx_file/crx_verifier.cc`).
 */
export const PUBLISHER_KEY_HASHES: ReadonlyMap<string, Exclude<CrxPublisher, 'unknown'>> = new Map<
  string,
  Exclude<CrxPublisher, 'unknown'>
>([
  // Chrome Web Store: ECDSA P-256 publisher key ("ecdsa_2017_public"), id gbphpckglpmphemnalmbpocejhmmjlae.
  ['61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf', 'chrome-web-store'],
  // Chrome Web Store: RSA-2048 store key, id lfoeajgcchlidpicbabpmckkejpckcfb.
  ['b5e4096227b83f82101fc2aa49f2a251accde3d98471464dd17d1819b43786b0', 'chrome-web-store'],
  // Edge Add-ons: ECDSA P-256 publisher key, id ghflnionnndifacabhhmmponkcfbadij.
  ['675bd8eddd385020177ccfeda25103895799fe41eca5c94e61dc13df359da1dc', 'edge-add-ons'],
  // Edge Add-ons: RSA-2048 store key, id ichpfokaninimeilopnpeolpmboclkbm.
  ['827f5ea0d8d8c48befdf4ebfc1e2ba1c35d9024e44491e1930d0f2cd7d56fb89', 'edge-add-ons']
])

/** Which store (if any) a set of verified key hashes points at. */
export function identifyPublisher(verifiedKeyHashes: Iterable<string>): CrxPublisher {
  for (const hash of verifiedKeyHashes) {
    const publisher = PUBLISHER_KEY_HASHES.get(hash)
    if (publisher) return publisher
  }
  return 'unknown'
}

/**
 * Parses the fixed prelude and the protobuf header without touching the network or the archive.
 * Throws `CrxError` for anything that is not a well-formed CRX3.
 */
export function parseCrxHeader(bytes: Uint8Array, options: CrxVerifyOptions = {}): CrxHeader {
  const maxHeaderLength = options.maxHeaderLength ?? DEFAULT_MAX_HEADER_LENGTH
  if (bytes.length < PRELUDE_LENGTH)
    throw new CrxError('truncated', 'File is too short to be a CRX')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== CRX3_MAGIC) throw new CrxError('bad-magic', 'Not a CRX file (bad magic number)')
  const version = view.getUint32(4, true)
  if (version !== CRX3_VERSION) {
    throw new CrxError(
      'unsupported-version',
      `Unsupported CRX version ${version}; only CRX3 is accepted`
    )
  }
  const headerLength = view.getUint32(8, true)
  if (headerLength > maxHeaderLength) {
    throw new CrxError('header-too-large', `CRX header of ${headerLength} bytes exceeds the limit`)
  }
  const zipOffset = PRELUDE_LENGTH + headerLength
  if (zipOffset > bytes.length)
    throw new CrxError('truncated', 'CRX header runs past the end of the file')

  const header = bytes.subarray(PRELUDE_LENGTH, zipOffset)
  const proofs: CrxProof[] = []
  let signedHeaderData: Uint8Array | null = null
  try {
    for (const field of decodeFields(header)) {
      if (field.wireType !== 2 || !field.bytes) continue
      if (field.fieldNumber === FIELD_RSA || field.fieldNumber === FIELD_ECDSA) {
        proofs.push(
          decodeProof(
            field.bytes,
            field.fieldNumber === FIELD_RSA ? 'sha256_with_rsa' : 'sha256_with_ecdsa'
          )
        )
      } else if (field.fieldNumber === FIELD_SIGNED_HEADER_DATA) {
        signedHeaderData = field.bytes
      }
    }
  } catch (error) {
    if (error instanceof ProtobufError) {
      throw new CrxError('malformed-header', `Malformed CRX header: ${error.message}`)
    }
    throw error
  }
  if (!signedHeaderData)
    throw new CrxError('malformed-header', 'CRX header has no signed_header_data')
  const crxId = decodeSignedData(signedHeaderData)
  if (proofs.length === 0) throw new CrxError('no-proofs', 'CRX header carries no signatures')
  return {
    headerLength,
    zipOffset,
    proofs,
    signedHeaderData,
    crxId,
    declaredId: idFromDigestPrefix(crxId)
  }
}

function decodeProof(bytes: Uint8Array, algorithm: CrxProofAlgorithm): CrxProof {
  let publicKey: Uint8Array | null = null
  let signature: Uint8Array | null = null
  for (const field of decodeFields(bytes)) {
    if (field.wireType !== 2 || !field.bytes) continue
    if (field.fieldNumber === 1) publicKey = field.bytes
    else if (field.fieldNumber === 2) signature = field.bytes
  }
  if (!publicKey || !signature || publicKey.length === 0 || signature.length === 0) {
    throw new ProtobufError('AsymmetricKeyProof lacks public_key or signature')
  }
  return { algorithm, publicKey, signature }
}

function decodeSignedData(bytes: Uint8Array): Uint8Array {
  let crxId: Uint8Array | null = null
  try {
    for (const field of decodeFields(bytes)) {
      if (field.fieldNumber === 1 && field.wireType === 2 && field.bytes) crxId = field.bytes
    }
  } catch (error) {
    if (error instanceof ProtobufError) {
      throw new CrxError('malformed-header', `Malformed CRX signed data: ${error.message}`)
    }
    throw error
  }
  if (!crxId || crxId.length !== CRX_ID_LENGTH) {
    throw new CrxError('malformed-header', 'CRX signed data has no 16-byte crx_id')
  }
  return crxId
}

/** The exact byte string every CRX3 proof signs. */
export function crxSignedMessage(signedHeaderData: Uint8Array, zip: Uint8Array): Uint8Array {
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, signedHeaderData.length, true)
  return concatBytes([SIGNATURE_CONTEXT, length, signedHeaderData, zip])
}

/**
 * Converts a DER `ECDSA-Sig-Value { INTEGER r, INTEGER s }` into the fixed-width `r || s` form
 * WebCrypto expects. `size` is the curve's coordinate size in bytes (32 for P-256).
 */
export function ecdsaDerToRaw(der: Uint8Array, size = 32): Uint8Array {
  let offset = 0
  const readLength = (): number => {
    if (offset >= der.length) throw new CrxError('bad-signature', 'Truncated DER signature')
    const first = der[offset++]
    if (first < 0x80) return first
    const count = first & 0x7f
    if (count === 0 || count > 2) throw new CrxError('bad-signature', 'Unsupported DER length')
    let value = 0
    for (let i = 0; i < count; i++) {
      if (offset >= der.length) throw new CrxError('bad-signature', 'Truncated DER signature')
      value = value * 256 + der[offset++]
    }
    return value
  }
  const readInteger = (): Uint8Array => {
    if (der[offset++] !== 0x02)
      throw new CrxError('bad-signature', 'DER signature: expected INTEGER')
    const length = readLength()
    if (offset + length > der.length) throw new CrxError('bad-signature', 'Truncated DER INTEGER')
    let value = der.subarray(offset, offset + length)
    offset += length
    while (value.length > 1 && value[0] === 0x00) value = value.subarray(1)
    if (value.length > size)
      throw new CrxError('bad-signature', 'DER INTEGER too large for the curve')
    const padded = new Uint8Array(size)
    padded.set(value, size - value.length)
    return padded
  }
  if (der[offset++] !== 0x30)
    throw new CrxError('bad-signature', 'DER signature: expected SEQUENCE')
  const sequenceLength = readLength()
  if (offset + sequenceLength !== der.length) {
    throw new CrxError('bad-signature', 'DER signature has trailing or missing bytes')
  }
  const r = readInteger()
  const s = readInteger()
  return concatBytes([r, s])
}

async function verifyProof(proof: CrxProof, message: Uint8Array): Promise<boolean> {
  const subtle = globalThis.crypto.subtle
  const key = asBufferSource(proof.publicKey)
  if (proof.algorithm === 'sha256_with_rsa') {
    let cryptoKey: CryptoKey
    try {
      cryptoKey = await subtle.importKey(
        'spki',
        key,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      )
    } catch {
      throw new CrxError('unsupported-key', 'CRX RSA public key could not be imported')
    }
    return subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      asBufferSource(proof.signature),
      asBufferSource(message)
    )
  }
  let cryptoKey: CryptoKey
  try {
    cryptoKey = await subtle.importKey('spki', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify'
    ])
  } catch {
    throw new CrxError('unsupported-key', 'CRX ECDSA public key is not a P-256 key')
  }
  return subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    asBufferSource(ecdsaDerToRaw(proof.signature)),
    asBufferSource(message)
  )
}

/**
 * Full verification: structure, every signature, and the developer-key/ID binding. Rejects (with a
 * `CrxError`) anything Chrome itself would refuse to install. The returned `zip` is a view into
 * `bytes`, so keep `bytes` alive while reading files from it.
 */
export async function verifyCrx(
  bytes: Uint8Array,
  options: CrxVerifyOptions = {}
): Promise<VerifiedCrx> {
  const header = parseCrxHeader(bytes, options)
  const zip = bytes.subarray(header.zipOffset)
  const message = crxSignedMessage(header.signedHeaderData, zip)

  const results = await Promise.all(
    header.proofs.map(async (proof) => ({
      proof,
      keyHash: toHex(await sha256(proof.publicKey)),
      valid: await verifyProof(proof, message)
    }))
  )
  const failed = results.find((r) => !r.valid)
  if (failed) {
    throw new CrxError(
      'bad-signature',
      `CRX ${failed.proof.algorithm} signature did not verify; the file is corrupt or tampered with`
    )
  }

  const developer = results.find(
    (r) =>
      r.proof.algorithm === 'sha256_with_rsa' &&
      bytesEqual(header.crxId, digestPrefixFromHex(r.keyHash))
  )
  if (!developer) {
    throw new CrxError(
      'id-mismatch',
      `CRX declares id ${header.declaredId} but no RSA signing key derives that id`
    )
  }

  const verifiedKeyHashes = results.map((r) => r.keyHash)
  const publisher = identifyPublisher(
    verifiedKeyHashes.filter((hash) => hash !== developer.keyHash)
  )
  return {
    id: header.declaredId,
    publicKey: developer.proof.publicKey,
    publisher,
    zipOffset: header.zipOffset,
    zip,
    verifiedKeyHashes
  }
}

function digestPrefixFromHex(hexDigest: string): Uint8Array {
  const out = new Uint8Array(CRX_ID_LENGTH)
  for (let i = 0; i < CRX_ID_LENGTH; i++) out[i] = parseInt(hexDigest.slice(i * 2, i * 2 + 2), 16)
  return out
}
