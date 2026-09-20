/**
 * Sample documents for the preview host's PDF viewer (`npm run dev:android`; `preview.ts`,
 * `previewStates.ts`): the dev server (`vite.android.config.ts`) serves the bytes this writes
 * for the file a `pdf=<variant>` state "downloads", so the viewer page and its controls run on
 * a real document in a desktop browser. Pure – no host or Node API – so the dev server, the
 * preview host and the tests all read the same table.
 *
 * `sample` is three Letter pages of the tide tables the engine run printed (a title band, a
 * table, paragraphs with "tide" in them for the find bar, a nested outline, a titled Info
 * dictionary); `locked` is the same document behind the standard security handler (RC4 40-bit,
 * the password {@link PREVIEW_PDF_PASSWORD}); `broken` is not a PDF at all; `slow` is `sample`
 * again, which the dev server answers late, for the viewer's loading state.
 */

export const PREVIEW_PDF_VARIANTS = ['sample', 'locked', 'broken', 'slow'] as const
export type PreviewPdfVariant = (typeof PREVIEW_PDF_VARIANTS)[number]

/** The file each variant "downloads" as; the preview host maps the path back to the variant. */
export const PREVIEW_PDF_FILES: Readonly<Record<PreviewPdfVariant, string>> = {
  sample: 'tide-tables.pdf',
  locked: 'harbour-accounts.pdf',
  broken: 'survey-scan.pdf',
  slow: 'moorings-register.pdf'
}

/** The user password of the `locked` document. */
export const PREVIEW_PDF_PASSWORD = 'zenium'

/** How long the dev server holds the `slow` document's bytes back. */
export const PREVIEW_PDF_SLOW_MS = 12_000

export function isPreviewPdfVariant(value: string): value is PreviewPdfVariant {
  return (PREVIEW_PDF_VARIANTS as readonly string[]).includes(value)
}

/** The variant behind a download's path (its file name), or null for a file this never wrote. */
export function previewPdfVariantOf(path: string): PreviewPdfVariant | null {
  const name = path.split('/').pop() ?? ''
  for (const variant of PREVIEW_PDF_VARIANTS)
    if (PREVIEW_PDF_FILES[variant] === name) return variant
  return null
}

/** The document's bytes. */
export function previewPdf(variant: PreviewPdfVariant): Uint8Array {
  switch (variant) {
    case 'broken':
      return encode('Scan of the survey, page 1 of 1.\nThe scanner wrote no PDF header.\n')
    case 'locked':
      return writeTides({ password: PREVIEW_PDF_PASSWORD })
    default:
      return writeTides(null)
  }
}

// ---------------------------------------------------------------------------------------------
// The tide tables
// ---------------------------------------------------------------------------------------------

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 48
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN

const PARAGRAPHS = [
  'The tide turns twice a day on this coast. High water follows the moon by about fifty minutes a day, so the tables below shift later through the week.',
  'Each tide is listed with its height in metres above chart datum. Springs this week: the tide runs strongest at the narrows on Wednesday and Thursday.',
  'Low water uncovers the flats for two hours either side. Check the tide before crossing to the island; the causeway floods from the seaward end first.',
  'Heights are predictions for the harbour entrance. Wind from the south-west can raise the water by a quarter of a metre; a steady northerly lowers it.',
  'Times are local. The harbour office keeps a barometer on the quay wall and posts a surge warning when the glass falls quickly.'
]

const ROWS = [
  ['Monday', '06:12', '4.8', '12:26', '0.9', '18:40', '5.0'],
  ['Tuesday', '06:58', '4.9', '13:11', '0.8', '19:25', '5.1'],
  ['Wednesday', '07:43', '5.1', '13:56', '0.6', '20:09', '5.2'],
  ['Thursday', '08:27', '5.2', '14:40', '0.5', '20:52', '5.2'],
  ['Friday', '09:10', '5.1', '15:23', '0.6', '21:35', '5.1'],
  ['Saturday', '09:53', '4.9', '16:06', '0.8', '22:17', '4.9'],
  ['Sunday', '10:36', '4.7', '16:48', '1.0', '22:59', '4.7']
]
const HEAD = ['Day', 'High', 'm', 'Low', 'm', 'High', 'm']
const COLUMNS = [108, 60, 40, 60, 40, 60, 40]

interface Heading {
  title: string
  /** The heading's baseline on its page: where an outline entry lands. */
  y: number
}

interface PageDraft {
  content: string
  headings: Heading[]
}

/** A page's drawing: the header band on the first, then headings, tables and paragraphs. */
class PageDrawer {
  private readonly ops: string[] = []
  private y = PAGE_HEIGHT - MARGIN
  private readonly index: number
  private readonly count: number
  readonly headings: Heading[] = []

  constructor(index: number, count: number) {
    this.index = index
    this.count = count
  }

  band(title: string, subtitle: string): void {
    this.ops.push(`0.051 0.361 0.478 rg 0 ${PAGE_HEIGHT - 96} ${PAGE_WIDTH} 96 re f`)
    this.text(title, 'F2', 26, MARGIN, PAGE_HEIGHT - 52, '1 1 1')
    this.text(subtitle, 'F1', 12, MARGIN, PAGE_HEIGHT - 76, '0.85 0.92 0.95')
    this.y = PAGE_HEIGHT - 96 - 36
  }

  note(line: string): void {
    const lines = wrap(line, 11, TEXT_WIDTH - 28)
    const height = lines.length * 16 + 16
    this.ops.push(`1 0.957 0.839 rg ${MARGIN} ${this.y - height + 12} ${TEXT_WIDTH} ${height} re f`)
    this.ops.push(`0.878 0.659 0 rg ${MARGIN} ${this.y - height + 12} 4 ${height} re f`)
    let y = this.y - 4
    for (const l of lines) {
      this.text(l, 'F1', 11, MARGIN + 16, y, '0.114 0.153 0.2')
      y -= 16
    }
    this.y -= height + 16
  }

  heading(title: string): void {
    this.y -= 8
    this.text(title, 'F2', 17, MARGIN, this.y, '0.051 0.361 0.478')
    this.headings.push({ title, y: this.y + 20 })
    this.y -= 26
  }

  table(): void {
    const rowHeight = 20
    const x0 = MARGIN
    const width = COLUMNS.reduce((a, b) => a + b, 0)
    const top = this.y + 6
    const rows = [HEAD, ...ROWS]
    this.ops.push(`0.902 0.941 0.961 rg ${x0} ${top - rowHeight} ${width} ${rowHeight} re f`)
    rows.forEach((row, r) => {
      if (r > 0 && r % 2 === 0)
        this.ops.push(
          `0.965 0.976 0.984 rg ${x0} ${top - (r + 1) * rowHeight} ${width} ${rowHeight} re f`
        )
      let x = x0
      row.forEach((cell, c) => {
        this.text(
          cell,
          r === 0 ? 'F2' : 'F1',
          10,
          x + 8,
          top - (r + 1) * rowHeight + 6,
          '0.114 0.153 0.2'
        )
        x += COLUMNS[c]
      })
    })
    // The grid: hairlines round every cell.
    this.ops.push('0.788 0.827 0.863 RG 0.6 w')
    for (let r = 0; r <= rows.length; r++)
      this.ops.push(`${x0} ${top - r * rowHeight} m ${x0 + width} ${top - r * rowHeight} l S`)
    let x = x0
    for (let c = 0; c <= COLUMNS.length; c++) {
      this.ops.push(`${x} ${top} m ${x} ${top - rows.length * rowHeight} l S`)
      x += COLUMNS[c] ?? 0
    }
    this.y = top - rows.length * rowHeight - 22
  }

  paragraph(text: string): void {
    for (const line of wrap(text, 11.5, TEXT_WIDTH)) {
      this.text(line, 'F1', 11.5, MARGIN, this.y, '0.114 0.153 0.2')
      this.y -= 17
    }
    this.y -= 9
  }

  draft(): PageDraft {
    this.text(
      `Page ${this.index + 1} of ${this.count}`,
      'F1',
      9,
      PAGE_WIDTH - MARGIN - 60,
      MARGIN - 16,
      '0.5 0.5 0.55'
    )
    return { content: this.ops.join('\n'), headings: this.headings }
  }

  private text(s: string, font: string, size: number, x: number, y: number, rgb: string): void {
    this.ops.push(`BT ${rgb} rg /${font} ${size} Tf ${x} ${y} Td (${escapeLiteral(s)}) Tj ET`)
  }
}

/** Word wrap for Helvetica at `size` points, from its average glyph width. */
function wrap(text: string, size: number, width: number): string[] {
  const perChar = size * 0.5
  const max = Math.max(8, Math.floor(width / perChar))
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length > max && line) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** An entry of the outline as the writer lays it out: the page it points at, children beneath. */
interface OutlineDraft {
  title: string
  page: number
  y: number
  children: OutlineDraft[]
}

function draftTides(): { pages: PageDraft[]; outline: OutlineDraft[] } {
  const pages: PageDraft[] = []
  const outline: OutlineDraft[] = []
  const count = 3
  for (let i = 0; i < count; i++) {
    const week = 38 + i
    const draw = new PageDrawer(i, count)
    if (i === 0) {
      draw.band(
        'Tide tables, week 38',
        'Estuary Harbour Office - predictions for the harbour entrance'
      )
      draw.note(
        'Springs this week. The tide runs strongest at the narrows; small craft should wait for slack water.'
      )
    } else {
      draw.heading(`Tide tables, week ${week}`)
    }
    draw.heading(`Week ${week}`)
    draw.table()
    const sections = i === 0 ? ['Springs and the narrows', 'Crossing to the island'] : []
    if (i === 2) sections.push('Notes for the harbour office')
    const entry: OutlineDraft = { title: `Week ${week}`, page: i, y: PAGE_HEIGHT, children: [] }
    for (let s = 0; s < 3; s++) {
      if (sections[s]) {
        draw.heading(sections[s])
        const heading = draw.headings[draw.headings.length - 1]
        entry.children.push({ title: sections[s], page: i, y: heading.y, children: [] })
      }
      draw.paragraph(PARAGRAPHS[(s * 2 + week) % PARAGRAPHS.length])
      draw.paragraph(PARAGRAPHS[(s * 2 + week + 1) % PARAGRAPHS.length])
    }
    outline.push(entry)
    pages.push(draw.draft())
  }
  return { pages, outline }
}

// ---------------------------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------------------------

/** A piece of an object's body: PDF syntax as is, a text string, or a stream's data. */
type Piece = string | { text: string } | { stream: string }

interface Encryption {
  /** Encrypt `data` as part of object `num` (generation 0). */
  encrypt(num: number, data: Uint8Array): Uint8Array
  /** The Encrypt dictionary's body, ready to write (its own strings are never encrypted). */
  dictionary: string
  /** The trailer's `/ID`, hex. */
  id: string
}

function writeTides(security: { password: string } | null): Uint8Array {
  const { pages, outline } = draftTides()
  const objects = new Map<number, Piece[]>()
  let next = 1
  const reserve = (): number => next++

  const catalog = reserve()
  const pagesRoot = reserve()
  const font = reserve()
  const fontBold = reserve()
  const info = reserve()
  const outlines = reserve()
  const pageNums = pages.map(() => ({ page: reserve(), content: reserve() }))

  objects.set(font, [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ])
  objects.set(fontBold, [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  ])
  pages.forEach((draft, i) => {
    const { page, content } = pageNums[i]
    objects.set(page, [
      `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${content} 0 R >>`
    ])
    objects.set(content, [{ stream: draft.content }])
  })
  objects.set(pagesRoot, [
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n.page} 0 R`).join(' ')}] /Count ${pages.length} >>`
  ])

  // The outline: every entry numbered first, then written with its siblings and children linked.
  const numbered: Array<{ num: number; draft: OutlineDraft; parent: number; children: number[] }> =
    []
  const number = (drafts: OutlineDraft[], parent: number): number[] =>
    drafts.map((draft) => {
      const num = reserve()
      const entry = { num, draft, parent, children: [] as number[] }
      numbered.push(entry)
      entry.children = number(draft.children, num)
      return num
    })
  const top = number(outline, outlines)
  const descendants = (nums: number[]): number => {
    let count = 0
    for (const n of nums) {
      count++
      const entry = numbered.find((e) => e.num === n)
      if (entry) count += descendants(entry.children)
    }
    return count
  }
  objects.set(outlines, [
    `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${descendants(top)} >>`
  ])
  for (const entry of numbered) {
    const siblings =
      entry.parent === outlines
        ? top
        : (numbered.find((e) => e.num === entry.parent)?.children ?? [])
    const at = siblings.indexOf(entry.num)
    const parts: Piece[] = [
      '<< /Title ',
      { text: entry.draft.title },
      ` /Parent ${entry.parent} 0 R`
    ]
    if (at > 0) parts.push(` /Prev ${siblings[at - 1]} 0 R`)
    if (at < siblings.length - 1) parts.push(` /Next ${siblings[at + 1]} 0 R`)
    if (entry.children.length > 0)
      parts.push(
        ` /First ${entry.children[0]} 0 R /Last ${entry.children[entry.children.length - 1]} 0 R /Count ${descendants(entry.children)}`
      )
    parts.push(
      ` /Dest [${pageNums[entry.draft.page].page} 0 R /XYZ 0 ${Math.round(entry.draft.y)} null] >>`
    )
    objects.set(entry.num, parts)
  }

  objects.set(info, [
    '<< /Title ',
    { text: 'Tide tables, week 38' },
    ' /Author ',
    { text: 'Estuary Harbour Office' },
    ' /Producer ',
    { text: 'Zenium preview host' },
    ' >>'
  ])
  objects.set(catalog, [
    `<< /Type /Catalog /Pages ${pagesRoot} 0 R /Outlines ${outlines} 0 R /PageMode /UseOutlines >>`
  ])

  const encryption = security ? standardSecurity(security.password) : null
  let encrypt = 0
  if (encryption) {
    encrypt = reserve()
    objects.set(encrypt, [encryption.dictionary])
  }

  // Serialise: header, the objects in number order, the cross-reference table, the trailer.
  const chunks: Uint8Array[] = []
  const offsets = new Map<number, number>()
  let length = 0
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes)
    length += bytes.length
  }
  push(encode('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'))
  for (let num = 1; num < next; num++) {
    const pieces = objects.get(num)
    if (!pieces) throw new Error(`object ${num} was reserved and never written`)
    offsets.set(num, length)
    push(encode(`${num} 0 obj\n`))
    for (const piece of pieces) {
      if (typeof piece === 'string') push(encode(piece))
      else if ('text' in piece) {
        const raw = encode(piece.text)
        if (encryption && num !== encrypt) push(encode(`<${hex(encryption.encrypt(num, raw))}>`))
        else push(encode(`(${escapeLiteral(piece.text)})`))
      } else {
        const raw = encode(piece.stream)
        const data = encryption ? encryption.encrypt(num, raw) : raw
        push(encode(`<< /Length ${data.length} >>\nstream\n`))
        push(data)
        push(encode('\nendstream'))
      }
    }
    push(encode('\nendobj\n'))
  }
  const xref = length
  const lines = [`xref\n0 ${next}\n0000000000 65535 f \n`]
  for (let num = 1; num < next; num++)
    lines.push(`${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`)
  push(encode(lines.join('')))
  const trailer = [`/Size ${next}`, `/Root ${catalog} 0 R`, `/Info ${info} 0 R`]
  if (encryption)
    trailer.push(`/Encrypt ${encrypt} 0 R`, `/ID [<${encryption.id}> <${encryption.id}>]`)
  push(encode(`trailer\n<< ${trailer.join(' ')} >>\nstartxref\n${xref}\n%%EOF\n`))

  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** Latin-1: every character of the drafts is one byte, and the PDF's own syntax is ASCII. */
function encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

// ---------------------------------------------------------------------------------------------
// The standard security handler, revision 2 (RC4, 40-bit): PDF 32000-1 §7.6.3
// ---------------------------------------------------------------------------------------------

const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
])
/** Every permission but the two revision 2 reserves (bits 1 and 2 clear). */
const PERMISSIONS = -4
const DOCUMENT_ID = encode('zenium-preview-pdf')

/** The document's encryption for `password` (as user and owner password alike). */
export function standardSecurity(password: string): Encryption {
  const id = md5(DOCUMENT_ID)
  const padded = padPassword(password)
  // Algorithm 3: the O entry.
  const ownerKey = md5(padded).subarray(0, 5)
  const o = rc4(ownerKey, padded)
  // Algorithm 2: the file key from the user password, O, P and the ID.
  const p = new Uint8Array([
    PERMISSIONS & 0xff,
    (PERMISSIONS >> 8) & 0xff,
    (PERMISSIONS >> 16) & 0xff,
    (PERMISSIONS >>> 24) & 0xff
  ])
  const key = md5(concat(padded, o, p, id)).subarray(0, 5)
  // Algorithm 4: the U entry.
  const u = rc4(key, PASSWORD_PAD)
  return {
    encrypt: (num, data) => {
      const objectKey = md5(
        concat(key, Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0]))
      ).subarray(0, 10)
      return rc4(objectKey, data)
    },
    dictionary: `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${PERMISSIONS} /O <${hex(o)}> /U <${hex(u)}> >>`,
    id: hex(id)
  }
}

function padPassword(password: string): Uint8Array {
  const raw = encode(password).subarray(0, 32)
  return concat(raw, PASSWORD_PAD.subarray(0, 32 - raw.length))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const MD5_K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0
)

export function md5(input: Uint8Array): Uint8Array {
  const total = Math.ceil((input.length + 9) / 64) * 64
  const padded = new Uint8Array(total)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = input.length * 8
  view.setUint32(total - 8, bits >>> 0, true)
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476
  const m = new Int32Array(16)
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(offset + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      f = (f + a + MD5_K[i] + m[g]) | 0
      a = d
      d = c
      c = b
      const shift = MD5_SHIFTS[(i >> 4) * 4 + (i & 3)]
      b = (b + ((f << shift) | (f >>> (32 - shift)))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setInt32(0, a0, true)
  outView.setInt32(4, b0, true)
  outView.setInt32(8, c0, true)
  outView.setInt32(12, d0, true)
  return out
}
