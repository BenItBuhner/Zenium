import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QrCodeRequest } from '@shared/qrScan'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn() }))
vi.mock('../ui', () => ({
  openQrCodeSheet: vi.fn(),
  closeQrCodeSheet: vi.fn()
}))

import type { QrCodePrompt } from '../ui'
import {
  QR_CODE_MAX_URL_LENGTH,
  currentQrCode,
  dismissQrCode,
  downloadQrCode,
  qrCodeErrorMessage,
  qrCodePath,
  setQrCodeIo,
  showQrCode,
  type QrCodeIo
} from '../qrCode'

/** The module's side effects, recorded. */
function harness(): {
  io: QrCodeIo
  downloads: string[]
  opened: QrCodePrompt[]
  closed: number[]
  order: string[]
} {
  const rec = {
    downloads: [] as string[],
    opened: [] as QrCodePrompt[],
    closed: [] as number[],
    order: [] as string[]
  }
  const io: QrCodeIo = {
    download: (url) => {
      rec.downloads.push(url)
      rec.order.push('download')
    },
    openSheet: async (prompt) => {
      rec.opened.push(prompt)
      rec.order.push('open')
    },
    closeSheet: (id) => {
      rec.closed.push(id)
      rec.order.push('close')
    }
  }
  return Object.assign(rec, { io })
}

/** A host's `qr.code` for a link that encoded: a tiny stand-in matrix. */
function request(overrides: Partial<QrCodeRequest> = {}): QrCodeRequest {
  return {
    url: 'https://example.com/',
    tabId: 't1',
    rows: ['0000', '0110', '0110', '0000'],
    error: null,
    ...overrides
  }
}

let restore: (() => void) | null = null

beforeEach(() => {
  restore = null
})

afterEach(() => {
  // A sheet left up by one test must not leak into the next.
  dismissQrCode()
  restore?.()
})

describe('showQrCode', () => {
  it('puts the sheet up with the request and a fresh id', async () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    await showQrCode(request())
    expect(h.opened).toHaveLength(1)
    const prompt = h.opened[0]!
    expect(prompt.url).toBe('https://example.com/')
    expect(prompt.tabId).toBe('t1')
    expect(prompt.rows).toEqual(['0000', '0110', '0110', '0000'])
    expect(prompt.error).toBeNull()
    expect(currentQrCode()).toBe(prompt)
    expect(h.closed).toEqual([])
  })

  it('a second share replaces the sheet: the first request is over, a new sheet rises', async () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    await showQrCode(request())
    const first = h.opened[0]!
    await showQrCode(request({ url: 'https://example.org/' }))
    expect(h.closed).toEqual([first.id])
    expect(h.opened).toHaveLength(2)
    expect(h.opened[1]!.id).not.toBe(first.id)
    expect(currentQrCode()?.url).toBe('https://example.org/')
  })

  it('carries the error for a link that made no code', async () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    await showQrCode(request({ rows: [], error: 'too-long' }))
    expect(h.opened[0]!.error).toBe('too-long')
    expect(h.opened[0]!.rows).toEqual([])
  })
})

describe('downloadQrCode', () => {
  it("closes the sheet first, as Chrome's dialog does, then asks the host for the picture", async () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    await showQrCode(request())
    const id = h.opened[0]!.id
    downloadQrCode()
    expect(h.closed).toEqual([id])
    expect(h.downloads).toEqual(['https://example.com/'])
    expect(h.order).toEqual(['open', 'close', 'download'])
    expect(currentQrCode()).toBeNull()
  })

  it('does nothing while the sheet shows an error in the code’s place', async () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    await showQrCode(request({ rows: [], error: 'failed' }))
    downloadQrCode()
    expect(h.downloads).toEqual([])
    expect(h.closed).toEqual([])
    expect(currentQrCode()).not.toBeNull()
  })

  it('does nothing with no sheet up', () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    downloadQrCode()
    expect(h.downloads).toEqual([])
    expect(h.closed).toEqual([])
  })
})

describe('dismissQrCode', () => {
  it('takes the sheet down and downloads nothing; a second dismiss finds nothing', async () => {
    const h = harness()
    restore = setQrCodeIo(h.io)
    await showQrCode(request())
    const id = h.opened[0]!.id
    dismissQrCode()
    dismissQrCode()
    expect(h.closed).toEqual([id])
    expect(h.downloads).toEqual([])
    expect(currentQrCode()).toBeNull()
  })
})

describe('qrCodePath', () => {
  it('draws each run of dark modules as one closed rectangle in module units', () => {
    expect(qrCodePath(['0000', '0110', '0110', '0000'])).toBe('M1 1h2v1h-2zM1 2h2v1h-2z')
  })

  it('splits runs at light modules and reaches the last column', () => {
    expect(qrCodePath(['1011'])).toBe('M0 0h1v1h-1zM2 0h2v1h-2z')
  })

  it('is empty for no code', () => {
    expect(qrCodePath([])).toBe('')
    expect(qrCodePath(['000', '000'])).toBe('')
  })
})

describe('qrCodeErrorMessage', () => {
  it("names Chrome's limit for a link that is too long", () => {
    expect(QR_CODE_MAX_URL_LENGTH).toBe(2331)
    expect(qrCodeErrorMessage('too-long')).toContain('2,331')
    expect(qrCodeErrorMessage('too-long')).toMatch(/too long/)
  })

  it('has a plain line for the encoder refusing the link', () => {
    expect(qrCodeErrorMessage('failed')).toBe('A QR code could not be made for this link')
  })
})
