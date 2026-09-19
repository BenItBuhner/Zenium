import type { JSX, RefObject } from 'react'
import { useEffect, useRef } from 'react'
import { Flashlight, QrCode } from 'lucide-react'
import type { QrSession } from '@shared/qrScan'
import { useEscapeUnlessLeaving } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import {
  cancelQrScan,
  layoutQrPreview,
  qrStore,
  releaseQrSession,
  toggleQrTorch
} from '@renderer/lib/qrScan'
import { uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * The scan sheet (OMN-22, NTP-04): a prompt sheet on the chassis (design language v2 draft
 * §9.23) that goes up as a camera button is tapped and stays while the host's camera looks for a
 * code. The title block reads "Scan a QR code" with the code glyph before it and a line on what
 * to do; the body is the framed target – a square window the host lays its live preview over,
 * corner brackets marking it as the place to hold the code – and, where the camera has one, the
 * torch toggle under it; Cancel is the one action. The payload is submitted by `lib/qrScan.ts`
 * the moment it decodes – the sheet does not wait for a tap – and the sheet goes with a short
 * haptic. Errors the user cannot answer here are toasts (§9.33), not sheet states.
 *
 * The preview is native (a camera surface cannot live in the chrome's document), laid over the
 * window's rectangle by the host and clipped to its corners. It only shows while the window
 * stands still: the sheet's rise, a drag, the back gesture and the leave hide it, and the last
 * still the host sent stands in the window meanwhile (`useNativePreview`), so the picture moves
 * with the sheet instead of trailing it. The host decodes only while the window shows the live
 * picture, so a code in front of the camera as the sheet moves is not read.
 *
 * Mounted once, above whichever shell is up. The leave outlives the request (`SheetPresence`,
 * §11.1): the store's `null` – a payload submitted, an error toasted, Cancel – runs the sheet
 * down; a new start meanwhile is a new sheet above it. Cancel in all its forms (the button,
 * Escape, the back gesture) ends the session first and lets the sheet leave on that, so the
 * camera is released as the fall starts and a decode during the fall lands on nothing; only a
 * drag or a scrim press, which the chassis answers itself, reach `onDismissed` at the landing.
 */
export function QrScanLayer(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.qrScan)
  return <SheetPresence>{prompt ? <QrSheet key={prompt.id} id={prompt.id} /> : null}</SheetPresence>
}

function QrSheet({ id }: { id: number }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const slot = useRef<HTMLDivElement>(null)
  const session = qrStore.use((s) => s.session)
  const leaving = useSheetLeave()?.leaving === true
  // The system back gesture pulls the sheet down like a drag; its commit, or the back button,
  // is Cancel: the session ends and the sheet leaves from where the gesture left it.
  useBackSurface({
    name: 'qr-scan',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: cancelQrScan,
    onCancel: () => sheet.current?.cancelBack()
  })
  // Escape cancels (hardware keyboards exist on tablets and DeX); a sheet on its way out lets
  // the key by.
  useEscapeUnlessLeaving(cancelQrScan, leaving)
  useNativePreview(slot, session?.phase === 'scanning' && !leaving)
  // The sheet has left: the session it drew goes with it (the still among it).
  useEffect(() => () => releaseQrSession(id), [id])

  const phase = session?.phase ?? 'cancelled'
  return (
    <BottomSheet
      ref={sheet}
      onDismissed={cancelQrScan}
      handleLabel="Dismiss"
      labelledBy="zen-qr-title"
      // The torch chip comes with `ready`, after the sheet measured itself: measure again so the
      // chip stands above the Cancel row rather than under it.
      contentKey={session?.torch ? 'torch' : 'plain'}
      footer={
        <button type="button" className="zen-v2-button" onClick={cancelQrScan}>
          Cancel
        </button>
      }
    >
      <div data-testid="qr-sheet" data-qr-phase={phase}>
        <div className="zen-sheet-title-block">
          <h2 id="zen-qr-title">
            <QrCode className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 truncate">Scan a QR code</span>
          </h2>
          <p>{phase === 'starting' ? 'Starting the camera' : 'Point the camera at a code'}</p>
        </div>
        <div className="zen-qr-body">
          <Target slot={slot} session={session} />
          {session?.torch && (
            <button
              type="button"
              className="zen-v2-button zen-qr-torch"
              aria-pressed={session.torchOn}
              data-testid="qr-torch"
              onClick={toggleQrTorch}
            >
              <Flashlight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              Torch
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}

/**
 * The framed target: the window the host's preview covers, a black square at the card radius
 * with the last still in it while the live picture is away, and the four corner brackets just
 * outside its edge that say "hold the code here". The whole window is what the decoder reads,
 * so the frame is the target and nothing is drawn over the picture.
 */
function Target({
  slot,
  session
}: {
  slot: RefObject<HTMLDivElement | null>
  session: QrSession | null
}): JSX.Element {
  const still = session?.still ?? null
  return (
    <div className="zen-qr-target" aria-hidden>
      <div
        ref={slot}
        className="zen-qr-window"
        data-testid="qr-window"
        data-live={session?.phase === 'scanning'}
      >
        {still && <img className="zen-qr-still" src={still} alt="" draggable={false} />}
      </div>
      <span className="zen-qr-corner" data-corner="tl" />
      <span className="zen-qr-corner" data-corner="tr" />
      <span className="zen-qr-corner" data-corner="bl" />
      <span className="zen-qr-corner" data-corner="br" />
    </div>
  )
}

/** How many frames the window has to stand still before the live preview is laid over it. */
const STILL_FRAMES = 3

/**
 * Keep the host's preview on the window. Every frame the window's rectangle is read; a change
 * hides the preview at once (the sheet is moving: rising, dragged, pulled by the back gesture,
 * receding under another sheet) and a rectangle that has held for [STILL_FRAMES] frames – with
 * no finger on the sheet and the sheet not on its way out – shows it there. Off the screen, or
 * once the sheet has nothing live to show, it stays hidden; unmounting hides it for good.
 */
function useNativePreview(slot: RefObject<HTMLDivElement | null>, live: boolean): void {
  useEffect(() => {
    if (!live) return
    let frame = 0
    let previous = ''
    let held = 0
    let shown = false
    const hide = (): void => {
      if (!shown) return
      shown = false
      layoutQrPreview({ rect: { x: 0, y: 0, width: 0, height: 0 }, radius: 0, visible: false })
    }
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const el = slot.current
      if (!el) return
      const box = el.getBoundingClientRect()
      const key = [box.left, box.top, box.width, box.height].map((v) => v.toFixed(1)).join(',')
      // A finger on the sheet, a sheet above it or a sheet on its way out: no live picture.
      const moving =
        key !== previous ||
        el.closest('[data-dragging], [data-recessed], [inert], [data-leaving]') !== null
      previous = key
      if (moving) {
        held = 0
        hide()
        return
      }
      const onScreen =
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.top < window.innerHeight &&
        box.right > 0 &&
        box.left < window.innerWidth
      if (!onScreen) {
        hide()
        return
      }
      if (shown || ++held < STILL_FRAMES) return
      shown = true
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
      layoutQrPreview({
        rect: { x: box.left, y: box.top, width: box.width, height: box.height },
        radius,
        visible: true
      })
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      hide()
    }
  }, [slot, live])
}
