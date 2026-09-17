/**
 * A strict zip reader for extension archives. The central directory is authoritative; entries are
 * decompressed lazily through `DecompressionStream('deflate-raw')` so a package is never held in
 * memory twice. Anything outside the profile Chrome's own unpacker needs (methods other than
 * stored/deflate, encryption, multi-disk sets, zip64) is rejected with a clear error.
 *
 * Web platform APIs only: shared by Electron's main process and the Android WebView.
 */
import { asBufferSource, utf8Decode } from './bytes'

export type ZipErrorCode =
  | 'not-a-zip'
  | 'truncated'
  | 'zip64-unsupported'
  | 'multi-disk'
  | 'encrypted'
  | 'unsupported-method'
  | 'bad-name'
  | 'path-traversal'
  | 'duplicate-entry'
  | 'too-many-entries'
  | 'too-large'
  | 'bad-local-header'
  | 'bad-crc'
  | 'inflate-failed'
  | 'size-mismatch'

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipLimits {
  maxEntries: number
  /** Sum of declared uncompressed sizes. */
  maxTotalSize: number
  maxEntrySize: number
}

/**
 * Generous by design: the limits guard against zip bombs, not disk budgets (hosts enforce those).
 * Real store packages are large; Adblock Plus 4.44 unpacks to 319 MiB of bundled rule sets.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 50_000,
  maxTotalSize: 1024 * 1024 * 1024,
  maxEntrySize: 512 * 1024 * 1024
}

export type ZipMethod = 0 | 8

export interface ZipEntry {
  /** Normalised path: forward slashes, no leading slash, no `.`/`..` segments. */
  path: string
  /** Uncompressed size in bytes. */
  size: number
  compressedSize: number
  method: ZipMethod
  crc32: number
  /**
   * Decompresses (and CRC-checks) the entry. Not cached: call once per entry and hand the bytes
   * to the host. Stored entries return a view into the archive rather than a copy.
   */
  bytes(): Promise<Uint8Array>
}

export interface ZipArchive {
  /** File entries in central-directory order (directory entries are listed separately). */
  entries: readonly ZipEntry[]
  /** Directory entries, normalised with a trailing slash. */
  directories: readonly string[]
  /** Sum of the uncompressed sizes of every file entry. */
  totalSize: number
  get(path: string): ZipEntry | undefined
}

const SIG_LOCAL_HEADER = 0x04034b50
const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const EOCD_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff
const CENTRAL_HEADER_LENGTH = 46
const LOCAL_HEADER_LENGTH = 30
const FLAG_ENCRYPTED = 0x0001

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), as used by zip
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Normalises an archive member name and rejects anything that could escape the extraction root:
 * absolute paths, drive letters, `.`/`..` segments, empty segments and control characters.
 * Backslashes are treated as separators (Windows-made archives). A trailing slash is preserved so
 * callers can tell directories apart.
 */
export function normalizeZipPath(rawName: string): string {
  const name = rawName.replace(/\\/g, '/')
  if (name.length === 0) throw new ZipError('bad-name', 'Zip entry has an empty name')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ZipError(
      'bad-name',
      `Zip entry name contains control characters: ${JSON.stringify(name)}`
    )
  }
  if (name.startsWith('/'))
    throw new ZipError('path-traversal', `Zip entry has an absolute path: ${name}`)
  if (/^[A-Za-z]:/.test(name)) {
    throw new ZipError('path-traversal', `Zip entry has a drive-letter path: ${name}`)
  }
  const isDirectory = name.endsWith('/')
  const segments = (isDirectory ? name.slice(0, -1) : name).split('/')
  for (const segment of segments) {
    if (segment === '..')
      throw new ZipError('path-traversal', `Zip entry escapes its root: ${name}`)
    if (segment === '' || segment === '.') {
      throw new ZipError('bad-name', `Zip entry has an empty or "." path segment: ${name}`)
    }
  }
  return isDirectory ? `${segments.join('/')}/` : segments.join('/')
}

// ---------------------------------------------------------------------------
// Inflate
// ---------------------------------------------------------------------------

/**
 * Raw-deflate decompression with a hard output bound: the entry's declared size. Output that
 * overshoots or undershoots the declaration fails with `size-mismatch`, which also defuses
 * decompression bombs that lie about their size.
 */
export async function inflateRaw(data: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const out = new Uint8Array(expectedSize)
  let written = 0
  // Errors in the compressed data surface on the reader side; the writer only needs draining.
  const feeding = writer
    .write(asBufferSource(data))
    .then(() => writer.close())
    .catch(() => undefined)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value as Uint8Array
      if (written + chunk.length > expectedSize) {
        await reader.cancel().catch(() => undefined)
        throw new ZipError(
          'size-mismatch',
          `Zip entry inflates past its declared size of ${expectedSize} bytes`
        )
      }
      out.set(chunk, written)
      written += chunk.length
    }
  } catch (error) {
    if (error instanceof ZipError) throw error
    throw new ZipError('inflate-failed', `Zip entry is not valid deflate data: ${describe(error)}`)
  } finally {
    await feeding
  }
  if (written !== expectedSize) {
    throw new ZipError(
      'size-mismatch',
      `Zip entry inflated to ${written} bytes but declares ${expectedSize}`
    )
  }
  return out
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

interface EndOfCentralDirectory {
  offset: number
  totalEntries: number
  centralDirectorySize: number
  centralDirectoryOffset: number
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): EndOfCentralDirectory {
  if (bytes.length < EOCD_LENGTH) throw new ZipError('not-a-zip', 'File is too short to be a zip')
  const lowest = Math.max(0, bytes.length - EOCD_LENGTH - MAX_COMMENT_LENGTH)
  let fallback = -1
  for (let pos = bytes.length - EOCD_LENGTH; pos >= lowest; pos--) {
    if (view.getUint32(pos, true) !== SIG_EOCD) continue
    const commentLength = view.getUint16(pos + 20, true)
    if (pos + EOCD_LENGTH + commentLength === bytes.length) return readEocd(view, pos)
    if (fallback < 0) fallback = pos
  }
  // A record whose comment length disagrees with the file length (trailing padding); the CRC
  // checks on every entry still protect the content.
  if (fallback >= 0) return readEocd(view, fallback)
  throw new ZipError('not-a-zip', 'No end-of-central-directory record found')
}

function readEocd(view: DataView, pos: number): EndOfCentralDirectory {
  const diskNumber = view.getUint16(pos + 4, true)
  const centralDirectoryDisk = view.getUint16(pos + 6, true)
  const entriesOnDisk = view.getUint16(pos + 8, true)
  const totalEntries = view.getUint16(pos + 10, true)
  const centralDirectorySize = view.getUint32(pos + 12, true)
  const centralDirectoryOffset = view.getUint32(pos + 16, true)
  const zip64Locator = pos >= 20 && view.getUint32(pos - 20, true) === SIG_ZIP64_LOCATOR
  if (
    zip64Locator ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new ZipError('zip64-unsupported', 'Zip64 archives are not supported')
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipError('multi-disk', 'Multi-disk (spanned) zip archives are not supported')
  }
  return { offset: pos, totalEntries, centralDirectorySize, centralDirectoryOffset }
}

/**
 * Parses the central directory and returns lazily-decompressing entries. Throws `ZipError` for
 * malformed, unsupported or unsafe archives; per-entry data problems (bad CRC, bad deflate stream)
 * surface from `entry.bytes()`.
 */
export async function readZip(
  bytes: Uint8Array,
  limits: Partial<ZipLimits> = {}
): Promise<ZipArchive> {
  const { maxEntries, maxTotalSize, maxEntrySize } = { ...DEFAULT_ZIP_LIMITS, ...limits }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(bytes, view)
  if (eocd.totalEntries > maxEntries) {
    throw new ZipError(
      'too-many-entries',
      `Zip has ${eocd.totalEntries} entries; the limit is ${maxEntries}`
    )
  }
  const centralEnd = eocd.centralDirectoryOffset + eocd.centralDirectorySize
  if (centralEnd > eocd.offset) {
    throw new ZipError(
      'truncated',
      'Zip central directory runs past the end-of-central-directory record'
    )
  }

  const entries: ZipEntry[] = []
  const directories: string[] = []
  const byPath = new Map<string, ZipEntry>()
  const seenFolded = new Set<string>()
  let totalSize = 0
  let cursor = eocd.centralDirectoryOffset

  for (let index = 0; index < eocd.totalEntries; index++) {
    if (cursor + CENTRAL_HEADER_LENGTH > centralEnd) {
      throw new ZipError('truncated', 'Zip central directory is truncated')
    }
    if (view.getUint32(cursor, true) !== SIG_CENTRAL_HEADER) {
      throw new ZipError('not-a-zip', `Bad central directory signature at entry ${index}`)
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const diskStart = view.getUint16(cursor + 34, true)
    const localHeaderOffset = view.getUint32(cursor + 42, true)
    const nameStart = cursor + CENTRAL_HEADER_LENGTH
    const entryEnd = nameStart + nameLength + extraLength + commentLength
    if (entryEnd > centralEnd)
      throw new ZipError('truncated', 'Zip central directory entry is truncated')

    let rawName: string
    try {
      rawName = utf8Decode(bytes.subarray(nameStart, nameStart + nameLength))
    } catch {
      throw new ZipError('bad-name', `Zip entry ${index} has a name that is not valid UTF-8`)
    }
    const path = normalizeZipPath(rawName)
    cursor = entryEnd

    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff
    ) {
      throw new ZipError('zip64-unsupported', `Zip entry ${path} uses zip64 fields`)
    }
    if (diskStart !== 0) throw new ZipError('multi-disk', `Zip entry ${path} lives on another disk`)
    if (path.endsWith('/')) {
      directories.push(path)
      continue
    }
    if (flags & FLAG_ENCRYPTED) throw new ZipError('encrypted', `Zip entry ${path} is encrypted`)
    if (method !== 0 && method !== 8) {
      throw new ZipError(
        'unsupported-method',
        `Zip entry ${path} uses compression method ${method}`
      )
    }
    if (size > maxEntrySize) {
      throw new ZipError(
        'too-large',
        `Zip entry ${path} declares ${size} bytes; the limit is ${maxEntrySize}`
      )
    }
    totalSize += size
    if (totalSize > maxTotalSize) {
      throw new ZipError('too-large', `Zip contents exceed the ${maxTotalSize}-byte limit`)
    }
    if (localHeaderOffset + LOCAL_HEADER_LENGTH > eocd.centralDirectoryOffset) {
      throw new ZipError('truncated', `Zip entry ${path} points outside the archive`)
    }
    const folded = path.toLowerCase()
    if (byPath.has(path) || seenFolded.has(folded)) {
      throw new ZipError(
        'duplicate-entry',
        `Zip contains ${path} more than once (case-insensitively)`
      )
    }
    seenFolded.add(folded)

    const entryMethod: ZipMethod = method === 8 ? 8 : 0
    const entry: ZipEntry = {
      path,
      size,
      compressedSize,
      method: entryMethod,
      crc32: crc,
      bytes: () =>
        readEntry(bytes, view, {
          path,
          size,
          compressedSize,
          method: entryMethod,
          crc,
          localHeaderOffset,
          dataLimit: eocd.centralDirectoryOffset
        })
    }
    entries.push(entry)
    byPath.set(path, entry)
  }

  return { entries, directories, totalSize, get: (path) => byPath.get(path) }
}

interface EntryLocation {
  path: string
  size: number
  compressedSize: number
  method: ZipMethod
  crc: number
  localHeaderOffset: number
  /** Entry data must end before the central directory begins. */
  dataLimit: number
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  loc: EntryLocation
): Promise<Uint8Array> {
  if (view.getUint32(loc.localHeaderOffset, true) !== SIG_LOCAL_HEADER) {
    throw new ZipError('bad-local-header', `Zip entry ${loc.path} has a bad local header`)
  }
  // The local header carries its own name/extra lengths, which may differ from the central copy.
  const nameLength = view.getUint16(loc.localHeaderOffset + 26, true)
  const extraLength = view.getUint16(loc.localHeaderOffset + 28, true)
  const dataStart = loc.localHeaderOffset + LOCAL_HEADER_LENGTH + nameLength + extraLength
  const dataEnd = dataStart + loc.compressedSize
  if (dataEnd > loc.dataLimit) {
    throw new ZipError('truncated', `Zip entry ${loc.path} data runs into the central directory`)
  }
  const compressed = bytes.subarray(dataStart, dataEnd)
  let data: Uint8Array
  if (loc.method === 0) {
    if (loc.compressedSize !== loc.size) {
      throw new ZipError('size-mismatch', `Stored zip entry ${loc.path} has inconsistent sizes`)
    }
    data = compressed
  } else {
    data = await inflateRaw(compressed, loc.size)
  }
  if (crc32(data) !== loc.crc) {
    throw new ZipError('bad-crc', `Zip entry ${loc.path} failed its CRC-32 check`)
  }
  return data
}
