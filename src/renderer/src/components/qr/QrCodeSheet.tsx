/* eslint-disable react-refresh/only-export-components -- the code sheet's kit: the content and the footer the two chassis draw (the sheet's own, the share panel's) ship with the hand-off's fade hook they pair with (`useHandOffOutgoing`) */
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { QrCode } from 'lucide-react'
import { useEscapeUnlessLeaving } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { dismissQrCode, downloadQrCode, qrCodeErrorMessage, qrCodePath } from '@renderer/lib/qrCode'
import { SHARE_SEAM_OUT_MS } from '@renderer/lib/shareSeam'
import { uiStore, type QrCodePrompt } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * The QR code sheet (SH-06): a prompt sheet on the chassis (design language v2 draft §9.23), the
 * scan sheet's sibling, that goes up as the share sheet's "QR code" is picked – Android 14's
 * action row or the panel's chip – with the link encoded by the host (`qr.code`). Chrome 152's
 * `QrCodeDialog` is a full-screen dialog with one tab, Share: a line on what to do, the code in a
 * white box with a hairline border (white in both themes – a camera reads it, not the theme),
 * and Download; its scan tab was removed in 2023 and it has no Share button. Zenium's form: the
 * title block with the code glyph and Chrome's line, the code black on a white card, the link
 * under it as the saved picture writes it (two lines at most, ellipsised), and Close | Download
 * in the footer. Download closes the sheet first, as Chrome's does, and the host's toast says
 * where the picture went. A link too long for a code, or one the encoder refused, shows Chrome's
 * message in the code's place with Download disabled.
 *
 * Two ways up. From the system share sheet (Android 14) the code sheet rises on its own, here:
 * mounted once, above whichever shell is up; the leave outlives the request (`SheetPresence`,
 * §11.1): the store's `null` – Download, Close, the back gesture – runs the sheet down; a new
 * share's code meanwhile is a new sheet above it. Only a drag or a scrim press, which the chassis
 * answers itself, reach `onDismissed` at the landing. From the browser's own share panel (Android
 * below 14) the code takes the panel's chassis instead (§9.38's hand-off, `lib/shareSeam.ts`):
 * the panel's sheet – the menu's, when that hosted the panel – draws `QrCodeHandOff` and
 * `QrCodeFooter` under the seam, and this layer stands aside.
 */
export function QrCodeLayer(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.qrCode)
  const hosted = uiStore.use(
    (s) => s.qrCodeSeam?.phase === 'hosting' && s.qrCodeSeam.promptId === s.qrCode?.id
  )
  return (
    <SheetPresence>
      {prompt && !hosted ? <CodeSheet key={prompt.id} prompt={prompt} /> : null}
    </SheetPresence>
  )
}

function CodeSheet({ prompt }: { prompt: QrCodePrompt }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const leaving = useSheetLeave()?.leaving === true
  // The system back gesture pulls the sheet down like a drag; its commit, or the back button,
  // is Close.
  useBackSurface({
    name: 'qr-code',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: dismissQrCode,
    onCancel: () => sheet.current?.cancelBack()
  })
  // Escape closes (hardware keyboards exist on tablets and DeX); a sheet on its way out lets
  // the key by.
  useEscapeUnlessLeaving(dismissQrCode, leaving)

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={dismissQrCode}
      handleLabel="Dismiss"
      labelledBy={QR_CODE_TITLE_ID}
      footer={<QrCodeFooter prompt={prompt} onClose={dismissQrCode} onDownload={downloadQrCode} />}
    >
      <QrCodeContent prompt={prompt} />
    </BottomSheet>
  )
}

/** The title block's heading, which names the sheet (`aria-labelledby`); one code sheet is up at a time. */
export const QR_CODE_TITLE_ID = 'zen-qr-code-title'

/**
 * The sheet's body: the §9.23 title block – the code glyph, "QR code", the line on what to do –
 * then the code black on its white card (the error in its place when there is none) and the
 * link under it. The same in the sheet's own chassis and in the panel's after the hand-off.
 */
export function QrCodeContent({ prompt }: { prompt: QrCodePrompt }): JSX.Element {
  const path = useMemo(() => qrCodePath(prompt.rows), [prompt.rows])
  const modules = prompt.rows.length
  return (
    <div data-testid="qr-code-sheet" data-qr-error={prompt.error ?? undefined}>
      <div className="zen-sheet-title-block">
        <h2 id={QR_CODE_TITLE_ID}>
          <QrCode className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 truncate">QR code</span>
        </h2>
        <p>Let someone nearby scan it to open the link.</p>
      </div>
      <div className="zen-qr-code-body">
        <div className="zen-qr-code-card">
          {prompt.error !== null ? (
            <p className="zen-qr-code-error" role="alert">
              {qrCodeErrorMessage(prompt.error)}
            </p>
          ) : (
            <svg
              className="zen-qr-code"
              viewBox={`0 0 ${modules} ${modules}`}
              role="img"
              aria-label="Generated QR code"
              shapeRendering="crispEdges"
              data-testid="qr-code-image"
              data-modules={modules}
            >
              <path d={path} fill="#000" />
            </svg>
          )}
        </div>
        <p className="zen-qr-code-url" data-testid="qr-code-url">
          {prompt.url}
        </p>
      </div>
    </div>
  )
}

/**
 * Close | Download (§9.11's peers; Download the primary, trailing, disabled while the card shows
 * an error). `className` rides the buttons – the seam's fade-in when the footer comes with the
 * hand-off (the footer's row lays the buttons out itself; a wrapper would break it).
 */
export function QrCodeFooter({
  prompt,
  onClose,
  onDownload,
  className
}: {
  prompt: QrCodePrompt
  onClose: () => void
  onDownload: () => void
  className?: string
}): JSX.Element {
  return (
    <>
      <button type="button" className={cn('zen-v2-button', className)} onClick={onClose}>
        Close
      </button>
      <button
        type="button"
        className={cn('zen-v2-button', className)}
        data-primary
        data-testid="qr-code-download"
        disabled={prompt.error !== null}
        onClick={onDownload}
      >
        Download
      </button>
    </>
  )
}

/**
 * The code in a chassis that was the share panel's (§9.38's hand-off, as the menu's sheet hands
 * itself to the panel): the panel's content once more – `outgoing`, inert and fading over §11's
 * 120 ms in an absolute layer, drawn from the hand-off's first frame – over the code's content
 * rising over 250 ms; the chassis measures its detents from the code alone and re-detents to
 * its height on the spring. Under reduced motion the contents cut (`outgoing` comes null).
 */
export function QrCodeHandOff({
  prompt,
  outgoing
}: {
  prompt: QrCodePrompt
  outgoing: ReactNode | null
}): JSX.Element {
  return (
    <div className="zen-share-seam" data-seam="qr-code">
      {outgoing !== null && (
        <div className="zen-share-seam-out" aria-hidden inert>
          {outgoing}
        </div>
      )}
      <div className="zen-share-seam-in">
        <QrCodeContent prompt={prompt} />
      </div>
    </div>
  )
}

/**
 * Whether the hand-off's outgoing layer is still to be drawn for `key` (the hosted code's id):
 * true from the hand-off's first frame for the fade's length, then false; false throughout under
 * reduced motion, where the contents cut. Null is no hand-off.
 */
export function useHandOffOutgoing(key: number | null): boolean {
  const [faded, setFaded] = useState<number | null>(null)
  useEffect(() => {
    if (key === null) return
    const timer = window.setTimeout(() => setFaded(key), SHARE_SEAM_OUT_MS)
    return () => window.clearTimeout(timer)
  }, [key])
  return key !== null && faded !== key && !reducedMotion()
}
