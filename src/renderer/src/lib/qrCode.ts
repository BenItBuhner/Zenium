/**
 * The QR code sheet (SH-06) as the chrome runs it: the share sheet's "QR code" – Android 14's
 * action row or the panel's chip – lands in the host's `Share.showQrCode`, which encodes the
 * link and sends `qr.code`; the sheet (`components/qr/QrCodeSheet.tsx`) draws the code and the
 * link, and its Download hands the link back (`qr.download`) for the host to keep the picture in
 * Downloads – the link written above the code, as Chrome 152's `QrCodeShareMediator` composes
 * it (`addUrlToBitmap`) – and to say so through its toast. The sheet closes on Download as
 * Chrome's dialog does (`mCloseDialog.run()` after `downloadQrCode`). This module owns the one
 * request and its side effects; the drawing is `qrCodePath`.
 */
import type { QrCodeRequest } from '@shared/qrScan'
import { run } from './api'
import { closeQrCodeSheet, openQrCodeSheet, type QrCodePrompt } from './ui'

/** Chrome's `QrCodeShareMediator.MAX_URL_LENGTH`, the host's limit too (`QrCodeLogic.MAX_URL_LENGTH`). */
export const QR_CODE_MAX_URL_LENGTH = 2331

/** What the module calls out to; the tests hand in their own. */
export interface QrCodeIo {
  download(url: string): void
  openSheet(prompt: QrCodePrompt): Promise<void>
  closeSheet(id: number): void
}

const DEFAULT_IO: QrCodeIo = {
  download: (url) => run('qr.download', { url }),
  openSheet: openQrCodeSheet,
  closeSheet: closeQrCodeSheet
}

let io: QrCodeIo = DEFAULT_IO
let seq = 0
/** The request whose sheet is up; null between requests. */
let current: QrCodePrompt | null = null

/** Tests: route the side effects elsewhere; the return value puts them back. */
export function setQrCodeIo(next: QrCodeIo): () => void {
  io = next
  return () => {
    io = DEFAULT_IO
  }
}

/** The request whose sheet is up, for the tests. */
export function currentQrCode(): QrCodePrompt | null {
  return current
}

/**
 * `qr.code` came: the sheet goes up with the link's code. A sheet still up from an earlier share
 * is replaced – its request is over and a new sheet rises above its leave (`SheetPresence`).
 */
export async function showQrCode(request: QrCodeRequest): Promise<void> {
  const previous = current
  const prompt: QrCodePrompt = { ...request, id: ++seq }
  current = prompt
  if (previous) io.closeSheet(previous.id)
  await io.openSheet(prompt)
}

/**
 * Download: the sheet goes first – Chrome's dialog closes on Download – and the host keeps the
 * picture and toasts the result. Nothing while the sheet shows an error in the code's place
 * (the button is disabled there; the guard is for a keyboard's Enter on a stale focus).
 */
export function downloadQrCode(): void {
  const prompt = current
  if (!prompt || prompt.error !== null) return
  end(prompt.id)
  io.download(prompt.url)
}

/**
 * Close (the button, Escape, the back gesture's commit, the sheet dragged or backed away): the
 * request is over and the sheet leaves from where it stands. Idempotent: the chassis's
 * `onDismissed` at the end of a drag's fall finds nothing left to close.
 */
export function dismissQrCode(): void {
  const prompt = current
  if (!prompt) return
  end(prompt.id)
}

function end(id: number): void {
  if (current?.id !== id) return
  current = null
  io.closeSheet(id)
}

/**
 * The code's dark modules as one SVG path in module units – a `viewBox` of the row count on a
 * side puts a module at 1×1 – each horizontal run of dark modules one closed rectangle, so a
 * 33-module code is a few hundred bytes of path rather than a thousand rects. The empty string
 * for no code.
 */
export function qrCodePath(rows: readonly string[]): string {
  const parts: string[] = []
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== '1') {
        x++
        continue
      }
      let run = 1
      while (row[x + run] === '1') run++
      parts.push(`M${x} ${y}h${run}v1h-${run}z`)
      x += run
    }
  })
  return parts.join('')
}

/**
 * The message in the code's place when there is no code – Chrome's `qr_code_error_too_long`
 * ("Can't create QR Code. URL is more than %1$d characters.") and `qr_code_error_unknown`
 * ("Can't create QR Code"), in Zenium's words.
 */
export function qrCodeErrorMessage(error: NonNullable<QrCodeRequest['error']>): string {
  return error === 'too-long'
    ? `This link is more than ${QR_CODE_MAX_URL_LENGTH.toLocaleString()} characters, too long for a QR code`
    : 'A QR code could not be made for this link'
}
