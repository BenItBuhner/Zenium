import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  familyFromNameTable,
  fontDirectories,
  fontFileFamilies,
  listFontFamilies,
  sfntFamilies
} from '../extensionApi/fontList'

interface NameEntry {
  platformId: number
  encodingId: number
  languageId: number
  nameId: number
  value: string
}

const WIN_EN = { platformId: 3, encodingId: 1, languageId: 0x0409 }
const MAC_ROMAN = { platformId: 1, encodingId: 0, languageId: 0 }

function utf16be(value: string): Buffer {
  const le = Buffer.from(value, 'utf16le')
  return le.swap16()
}

/** A `name` table (format 0) from the entries, strings packed after the records. */
function nameTable(entries: NameEntry[]): Buffer {
  const strings: Buffer[] = []
  const records: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const bytes = entry.platformId === 1 ? Buffer.from(entry.value, 'latin1') : utf16be(entry.value)
    const record = Buffer.alloc(12)
    record.writeUInt16BE(entry.platformId, 0)
    record.writeUInt16BE(entry.encodingId, 2)
    record.writeUInt16BE(entry.languageId, 4)
    record.writeUInt16BE(entry.nameId, 6)
    record.writeUInt16BE(bytes.length, 8)
    record.writeUInt16BE(offset, 10)
    records.push(record)
    strings.push(bytes)
    offset += bytes.length
  }
  const header = Buffer.alloc(6)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(entries.length, 2)
  header.writeUInt16BE(6 + entries.length * 12, 4)
  return Buffer.concat([header, ...records, ...strings])
}

/** An offset table with one `name` record pointing at `nameAt` (absolute), for a face at `faceAt`. */
function offsetTable(tag: number, nameAt: number, nameLength: number, extraTables = 0): Buffer {
  const numTables = 1 + extraTables
  const header = Buffer.alloc(12)
  header.writeUInt32BE(tag, 0)
  header.writeUInt16BE(numTables, 4)
  const records: Buffer[] = []
  for (let i = 0; i < extraTables; i++) {
    const record = Buffer.alloc(16)
    record.write('glyf', 0, 'latin1')
    record.writeUInt32BE(0, 8)
    record.writeUInt32BE(0, 12)
    records.push(record)
  }
  const nameRecord = Buffer.alloc(16)
  nameRecord.write('name', 0, 'latin1')
  nameRecord.writeUInt32BE(nameAt, 8)
  nameRecord.writeUInt32BE(nameLength, 12)
  records.push(nameRecord)
  return Buffer.concat([header, ...records])
}

/** One TrueType (`0x00010000`) or CFF (`OTTO`) font with these names. */
function font(entries: NameEntry[], tag = 0x00010000, extraTables = 1): Buffer {
  const table = nameTable(entries)
  const directoryLength = 12 + 16 * (1 + extraTables)
  return Buffer.concat([offsetTable(tag, directoryLength, table.length, extraTables), table])
}

/** A collection of faces, each with its own names (table offsets absolute, as in a file). */
function collection(faces: NameEntry[][]): Buffer {
  const header = Buffer.alloc(12 + 4 * faces.length)
  header.write('ttcf', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt32BE(faces.length, 8)
  const tables = faces.map((entries) => nameTable(entries))
  let at = header.length
  const directories: Buffer[] = []
  const directoryLength = 12 + 16
  const namesStart = at + directoryLength * faces.length
  let nameAt = namesStart
  faces.forEach((_, i) => {
    header.writeUInt32BE(at, 12 + 4 * i)
    directories.push(offsetTable(0x00010000, nameAt, tables[i].length))
    at += directoryLength
    nameAt += tables[i].length
  })
  return Buffer.concat([header, ...directories, ...tables])
}

const readerOf =
  (bytes: Buffer) =>
  async (offset: number, length: number): Promise<Buffer | null> =>
    offset + length <= bytes.length ? bytes.subarray(offset, offset + length) : null

describe('familyFromNameTable', () => {
  it('prefers the typographic family, Windows English first', () => {
    const table = nameTable([
      { ...MAC_ROMAN, nameId: 1, value: 'Noto Sans Display Cond' },
      { ...WIN_EN, nameId: 1, value: 'Noto Sans Display Condensed' },
      { ...WIN_EN, languageId: 0x040c, nameId: 16, value: 'Noto Sans Display (fr)' },
      { ...WIN_EN, nameId: 16, value: 'Noto Sans Display' }
    ])
    expect(familyFromNameTable(table)).toBe('Noto Sans Display')
  })

  it('falls back to the legacy family and the Macintosh record, and reads nothing from junk', () => {
    expect(familyFromNameTable(nameTable([{ ...MAC_ROMAN, nameId: 1, value: 'Arimo' }]))).toBe(
      'Arimo'
    )
    expect(
      familyFromNameTable(
        nameTable([
          { platformId: 0, encodingId: 3, languageId: 0, nameId: 1, value: 'Unicode Face' },
          { ...WIN_EN, nameId: 2, value: 'Regular' }
        ])
      )
    ).toBe('Unicode Face')
    expect(familyFromNameTable(Buffer.from([0, 0, 0]))).toBeNull()
    expect(
      familyFromNameTable(nameTable([{ ...WIN_EN, nameId: 4, value: 'Full name' }]))
    ).toBeNull()
    // A record whose string runs past the table is skipped, not read.
    const broken = nameTable([{ ...WIN_EN, nameId: 1, value: 'Cut' }])
    broken.writeUInt16BE(500, 6 + 8)
    expect(familyFromNameTable(broken)).toBeNull()
  })
})

describe('sfntFamilies', () => {
  it('reads a TrueType face, a CFF face and every face of a collection', async () => {
    expect(await sfntFamilies(readerOf(font([{ ...WIN_EN, nameId: 1, value: 'Tinos' }])))).toEqual([
      'Tinos'
    ])
    expect(
      await sfntFamilies(readerOf(font([{ ...WIN_EN, nameId: 16, value: 'Cousine' }], 0x4f54544f)))
    ).toEqual(['Cousine'])
    const ttc = collection([
      [{ ...WIN_EN, nameId: 1, value: 'Noto Sans CJK JP' }],
      [{ ...WIN_EN, nameId: 1, value: 'Noto Sans CJK KR' }],
      [{ ...WIN_EN, nameId: 1, value: 'Noto Sans CJK JP' }]
    ])
    expect(await sfntFamilies(readerOf(ttc))).toEqual(['Noto Sans CJK JP', 'Noto Sans CJK KR'])
  })

  it('reads nothing from a file that is not a font, or is cut short', async () => {
    expect(await sfntFamilies(readerOf(Buffer.from('not a font at all, just text')))).toEqual([])
    expect(await sfntFamilies(readerOf(Buffer.alloc(4)))).toEqual([])
    const cut = font([{ ...WIN_EN, nameId: 1, value: 'Cut Short' }]).subarray(0, 40)
    expect(await sfntFamilies(readerOf(cut))).toEqual([])
  })
})

describe('listFontFamilies', () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-fonts-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('walks the directories, follows linked files, and lists each family once', async () => {
    const a = join(root, 'a')
    const nested = join(a, 'truetype', 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(a, 'Arimo-Regular.ttf'), font([{ ...WIN_EN, nameId: 1, value: 'Arimo' }]))
    writeFileSync(join(a, 'Arimo-Bold.ttf'), font([{ ...WIN_EN, nameId: 1, value: 'Arimo' }]))
    writeFileSync(
      join(nested, 'Cousine.otf'),
      font([{ ...WIN_EN, nameId: 16, value: 'Cousine' }], 0x4f54544f)
    )
    writeFileSync(
      join(nested, 'NotoCJK.ttc'),
      collection([[{ ...WIN_EN, nameId: 1, value: 'Noto Sans CJK JP' }]])
    )
    writeFileSync(join(a, 'README.txt'), 'not a font')
    writeFileSync(join(a, 'broken.ttf'), 'not a font either')
    writeFileSync(join(a, '.hidden.ttf'), font([{ ...WIN_EN, nameId: 1, value: 'Hidden' }]))
    const b = join(root, 'b')
    mkdirSync(b)
    writeFileSync(join(b, 'Tinos.ttf'), font([{ ...WIN_EN, nameId: 1, value: 'Tinos' }]))
    symlinkSync(join(b, 'Tinos.ttf'), join(a, 'Tinos-link.ttf'))
    // A directory loop through a link: walked once, never in circles.
    symlinkSync(a, join(nested, 'loop'))
    const names = await listFontFamilies([a, join(root, 'missing')])
    expect(names.sort()).toEqual(['Arimo', 'Cousine', 'Noto Sans CJK JP', 'Tinos'])
    expect(await fontFileFamilies(join(a, 'broken.ttf'))).toEqual([])
    expect(await fontFileFamilies(join(a, 'nope.ttf'))).toEqual([])
  })
})

describe('fontDirectories', () => {
  it('names the platform\u2019s font directories', () => {
    expect(fontDirectories('darwin', {}, '/Users/me')).toEqual([
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      '/Users/me/Library/Fonts'
    ])
    expect(
      fontDirectories(
        'win32',
        { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        'C:\\Users\\me'
      )
    ).toEqual([
      join('C:\\Windows', 'Fonts'),
      join('C:\\Users\\me\\AppData\\Local', 'Microsoft/Windows/Fonts')
    ])
    expect(
      fontDirectories('linux', { XDG_DATA_DIRS: '/usr/local/share:/usr/share:' }, '/home/me')
    ).toEqual([
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      '/home/me/.fonts',
      '/home/me/.local/share/fonts'
    ])
    expect(
      fontDirectories('linux', { XDG_DATA_HOME: '/data', XDG_DATA_DIRS: '/opt/share' }, '/home/me')
    ).toEqual([
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      '/home/me/.fonts',
      '/data/fonts',
      '/opt/share/fonts'
    ])
  })
})
