import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The installed font families, for `chrome.fontSettings.getFontList`. Electron's main process
 * has no font enumeration (Chrome's `FontList::GetFontList` is the browser's; the renderer's
 * `queryLocalFonts()` needs a document with the `local-fonts` grant, which only the chrome's own
 * documents hold), so the families are read from the font files themselves: every OpenType or
 * TrueType face under the platform's font directories, by its `name` table – the typographic
 * family (name 16) where the face has one, else the family (name 1) – so "Noto Sans Display"
 * lists once for its weights, as Chrome lists it. Only the header and the `name` table are
 * read of each file; collections (`ttcf`) list every face. Anything unreadable is skipped.
 */

/** Where the platform keeps its fonts (Chrome's font directories, as fontconfig / CoreText / GDI see them). */
export function fontDirectories(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/System/Library/Fonts',
        '/System/Library/Fonts/Supplemental',
        '/Library/Fonts',
        join(home, 'Library/Fonts')
      ]
    case 'win32': {
      const out = [join(env.WINDIR ?? 'C:\\Windows', 'Fonts')]
      if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Microsoft/Windows/Fonts'))
      return out
    }
    default: {
      const out = ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.fonts')]
      const dataHome = env.XDG_DATA_HOME || join(home, '.local/share')
      out.push(join(dataHome, 'fonts'))
      for (const dir of (env.XDG_DATA_DIRS ?? '').split(':')) {
        if (dir !== '') out.push(join(dir, 'fonts'))
      }
      return [...new Set(out)]
    }
  }
}

const FONT_EXTENSIONS = /\.(ttf|otf|ttc|otc)$/i
const MAX_DEPTH = 8
/** A `name` table beyond this is not a font's (the largest real ones are a few tens of KB). */
const MAX_NAME_TABLE = 1 << 20

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */])
const TTC_TAG = 0x74746366 /* ttcf */

/** Every family name under the directories, each once; unreadable files and directories are skipped. */
export async function listFontFamilies(
  directories: string[] = fontDirectories()
): Promise<string[]> {
  const names = new Set<string>()
  const seenDirs = new Set<string>()
  for (const dir of directories) await walk(dir, 0, names, seenDirs)
  return [...names]
}

async function walk(
  dir: string,
  depth: number,
  names: Set<string>,
  seen: Set<string>
): Promise<void> {
  if (depth > MAX_DEPTH) return
  let real: string
  try {
    real = await fs.realpath(dir)
  } catch {
    return
  }
  if (seen.has(real)) return
  seen.add(real)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      // A linked file counts (Linux distributions link fonts into place); a linked directory
      // is walked through its real path once, so a loop cannot run the walk in circles.
      try {
        const stat = await fs.stat(path)
        isDir = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        continue
      }
    }
    if (isDir) await walk(path, depth + 1, names, seen)
    else if (isFile && FONT_EXTENSIONS.test(entry.name)) {
      for (const name of await fontFileFamilies(path)) names.add(name)
    }
  }
}

/** The family names of the faces in one font file (empty for anything that is not a readable sfnt). */
export async function fontFileFamilies(path: string): Promise<string[]> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(path, 'r')
  } catch {
    return []
  }
  try {
    const read = async (offset: number, length: number): Promise<Buffer | null> => {
      if (length <= 0 || length > MAX_NAME_TABLE) return null
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : null
    }
    return await sfntFamilies(read)
  } catch {
    return []
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Reads `length` bytes at `offset`, or null past the end. */
export type ByteReader = (offset: number, length: number) => Promise<Buffer | null>

/** The family names of a font file given a reader over its bytes: one face, or every face of a collection. */
export async function sfntFamilies(read: ByteReader): Promise<string[]> {
  const head = await read(0, 12)
  if (!head) return []
  const tag = head.readUInt32BE(0)
  const offsets: number[] = []
  if (tag === TTC_TAG) {
    const count = head.readUInt32BE(8)
    if (count === 0 || count > 256) return []
    const table = await read(12, count * 4)
    if (!table) return []
    for (let i = 0; i < count; i++) offsets.push(table.readUInt32BE(i * 4))
  } else if (SFNT_VERSIONS.has(tag)) {
    offsets.push(0)
  } else {
    return []
  }
  const names: string[] = []
  for (const offset of offsets) {
    const name = await faceFamily(read, offset)
    if (name !== null && !names.includes(name)) names.push(name)
  }
  return names
}

/** One face's family name from the `name` table at its offset table, or null. */
async function faceFamily(read: ByteReader, faceOffset: number): Promise<string | null> {
  const header = await read(faceOffset, 12)
  if (!header || !SFNT_VERSIONS.has(header.readUInt32BE(0))) return null
  const numTables = header.readUInt16BE(4)
  if (numTables === 0 || numTables > 512) return null
  const records = await read(faceOffset + 12, numTables * 16)
  if (!records) return null
  for (let i = 0; i < numTables; i++) {
    const at = i * 16
    if (records.toString('latin1', at, at + 4) !== 'name') continue
    const offset = records.readUInt32BE(at + 8)
    const length = records.readUInt32BE(at + 12)
    const table = await read(offset, length)
    return table ? familyFromNameTable(table) : null
  }
  return null
}

interface NameRecord {
  platformId: number
  encodingId: number
  languageId: number
  nameId: number
  value: string
}

/**
 * The family from a `name` table: the typographic family (16) over the legacy family (1); of
 * the records for a name, Windows English (platform 3, language 0x0409) first, then any
 * Windows or Unicode record, then the Macintosh Roman one.
 */
export function familyFromNameTable(table: Buffer): string | null {
  if (table.length < 6) return null
  const count = table.readUInt16BE(2)
  const stringsAt = table.readUInt16BE(4)
  const records: NameRecord[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12
    if (at + 12 > table.length) break
    const platformId = table.readUInt16BE(at)
    const encodingId = table.readUInt16BE(at + 2)
    const languageId = table.readUInt16BE(at + 4)
    const nameId = table.readUInt16BE(at + 6)
    if (nameId !== 1 && nameId !== 16) continue
    const length = table.readUInt16BE(at + 8)
    const offset = table.readUInt16BE(at + 10)
    const start = stringsAt + offset
    if (start + length > table.length) continue
    const value = decodeName(table.subarray(start, start + length), platformId, encodingId)
    if (value !== null) records.push({ platformId, encodingId, languageId, nameId, value })
  }
  for (const nameId of [16, 1]) {
    const candidates = records.filter((r) => r.nameId === nameId)
    if (candidates.length === 0) continue
    const pick =
      candidates.find((r) => r.platformId === 3 && r.languageId === 0x0409) ??
      candidates.find((r) => r.platformId === 3 || r.platformId === 0) ??
      candidates.find((r) => r.platformId === 1 && r.encodingId === 0)
    if (pick && pick.value !== '') return pick.value
  }
  return null
}

function decodeName(bytes: Buffer, platformId: number, encodingId: number): string | null {
  if (platformId === 3 || platformId === 0) {
    if (platformId === 3 && encodingId !== 1 && encodingId !== 10) return null
    // UTF-16BE: swap into the little-endian order Node decodes.
    if (bytes.length % 2 !== 0) return null
    const swapped = Buffer.from(bytes)
    swapped.swap16()
    return clean(swapped.toString('utf16le'))
  }
  if (platformId === 1) {
    if (encodingId !== 0) return null
    return clean(bytes.toString('latin1'))
  }
  return null
}

function clean(value: string): string | null {
  const trimmed = value.replace(/\0/g, '').trim()
  return trimmed === '' ? null : trimmed
}
