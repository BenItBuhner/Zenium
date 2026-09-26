import type { JSX } from 'react'
import { useMemo, useRef } from 'react'
import { QrCode } from 'lucide-react'
import { useEscapeUnlessLeaving } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import { dismissQrCode, downloadQrCode, qrCodeErrorMessage, qrCodePath } from '@renderer/lib/qrCode'
import { uiStore, type QrCodePrompt } from '@renderer/lib/ui'
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
 * Mounted once, above whichever shell is up. The leave outlives the request (`SheetPresence`,
 * §11.1): the store's `null` – Download, Close, the back gesture – runs the sheet down; a new
 * share's code meanwhile is a new sheet above it. Only a drag or a scrim press, which the chassis
 * answers itself, reach `onDismissed` at the landing.
 */
export function QrCodeLayer(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.qrCode)
  return (
    <SheetPresence>{prompt ? <CodeSheet key={prompt.id} prompt={prompt} /> : null}</SheetPresence>
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
  const path = useMemo(() => qrCodePath(prompt.rows), [prompt.rows])
  const modules = prompt.rows.length

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={dismissQrCode}
      handleLabel="Dismiss"
      labelledBy="zen-qr-code-title"
      footer={
        <>
          <button type="button" className="zen-v2-button" onClick={dismissQrCode}>
            Close
          </button>
          <button
            type="button"
            className="zen-v2-button"
            data-primary
            data-testid="qr-code-download"
            disabled={prompt.error !== null}
            onClick={downloadQrCode}
          >
            Download
          </button>
        </>
      }
    >
      <div data-testid="qr-code-sheet" data-qr-error={prompt.error ?? undefined}>
        <div className="zen-sheet-title-block">
          <h2 id="zen-qr-code-title">
            <QrCode className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 truncate">QR code</span>
          </h2>
          <p>Let someone nearby scan it to open the link</p>
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
    </BottomSheet>
  )
}
