import { describe, expect, it } from 'vitest'
import {
  isPreviewPdfVariant,
  md5,
  PREVIEW_PDF_FILES,
  PREVIEW_PDF_VARIANTS,
  previewPdf,
  previewPdfVariantOf,
  rc4
} from '../previewPdf'

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes)
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

describe('previewPdf', () => {
  it('names a file per variant and maps a download path back to its variant', () => {
    for (const variant of PREVIEW_PDF_VARIANTS) {
      expect(isPreviewPdfVariant(variant)).toBe(true)
      expect(
        previewPdfVariantOf(`/storage/emulated/0/Download/${PREVIEW_PDF_FILES[variant]}`)
      ).toBe(variant)
    }
    expect(isPreviewPdfVariant('report')).toBe(false)
    expect(previewPdfVariantOf('/storage/emulated/0/Download/report.pdf')).toBeNull()
  })

  it('writes the tide tables as a PDF with three pages, a title and a nested outline', () => {
    const text = latin1(previewPdf('sample'))
    expect(text.startsWith('%PDF-1.7\n')).toBe(true)
    expect(text.endsWith('%%EOF\n')).toBe(true)
    expect(text).toContain('/Type /Pages /Kids [')
    expect(text).toContain('/Count 3 >>')
    expect(text).toContain('/Title (Tide tables, week 38)')
    expect(text).toContain('/Type /Outlines')
    expect(text).toContain('/Title (Springs and the narrows)')
    expect(text).not.toContain('/Encrypt')
    // The cross-reference table points at every object where it was written.
    const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1])
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref')
    const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    expect(entries.length).toBeGreaterThan(10)
    entries.forEach((offset, i) =>
      expect(text.slice(offset, offset + 12)).toMatch(`${i + 1} 0 obj`)
    )
  })

  it('locks the same document behind the standard security handler, its strings encrypted', () => {
    const text = latin1(previewPdf('locked'))
    expect(text).toContain('/Filter /Standard /V 1 /R 2 /Length 40')
    expect(text).toMatch(/\/Encrypt \d+ 0 R \/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/)
    expect(text).not.toContain('/Title (Tide tables, week 38)')
    expect(text).not.toContain('Springs and the narrows')
    // The slow document is the plain one, held back by the server rather than the writer.
    expect(previewPdf('slow')).toEqual(previewPdf('sample'))
  })

  it('writes no PDF at all for the broken variant', () => {
    const text = latin1(previewPdf('broken'))
    expect(text.startsWith('%PDF')).toBe(false)
    expect(text).toContain('no PDF header')
  })

  it('computes MD5 and RC4 as the security handler needs them (RFC 1321, RFC 6229 vectors)', () => {
    expect(hex(md5(ascii('')))).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(hex(md5(ascii('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(hex(md5(ascii('The quick brown fox jumps over the lazy dog')))).toBe(
      '9e107d9d372bb6826bd81d3542a419d6'
    )
    // Past one 64-byte block, so the length trailer lands in a second one.
    expect(hex(md5(ascii('a'.repeat(100))))).toBe('36a92cc94a9e0fa21f625f8bfb007adf')
    // RC4 with the 40-bit key 01 02 03 04 05: the first keystream bytes of RFC 6229.
    const stream = rc4(Uint8Array.from([1, 2, 3, 4, 5]), new Uint8Array(16))
    expect(hex(stream)).toBe('b2396305f03dc027ccc3524a0a1118a8')
    // Decrypting is encrypting again.
    const key = ascii('Key')
    expect(latin1(rc4(key, rc4(key, ascii('Plaintext'))))).toBe('Plaintext')
    expect(hex(rc4(key, ascii('Plaintext')))).toBe('bbf316e8d940af0ad3')
  })
})
