import type { JSX, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LongCapture, LongCaptureCrop } from '@shared/types'
import { SheetPresence } from '@renderer/lib/motion/presence'
import {
  closeLongScreenshot,
  saveLongScreenshot,
  uiStore,
  type LongScreenshotEditor
} from '@renderer/lib/ui'
import { useSheetRest } from '@renderer/lib/motion/sheetRest'
import { Btn } from '../autofill/controls'
import { fitScale } from './longScreenshotFit'
import { PhoneSheet } from './PhoneSheet'

/**
 * The long-screenshot editor while its request stands, in the frame dialog host `TabDialogs`
 * mounts. The leave outlives the request (`SheetPresence`, §11.1): the store's `null` – the
 * save took, the sheet was closed – runs the sheet down on its own motion.
 */
export function LongScreenshotLayer(): JSX.Element | null {
  const editor = uiStore.use((s) => s.longScreenshot)
  return (
    <SheetPresence>
      {editor ? <LongScreenshotSheet key={editor.id} editor={editor} /> : null}
    </SheetPresence>
  )
}

/** The least a crop keeps, in the frame's CSS px: room for the two handles not to meet. */
const MIN_CROP_PX = 48
/** How far in from the scroller's edge a dragged handle starts pulling the picture along (CSS px). */
const EDGE_FOLLOW_PX = 40
/** An arrow key moves a handle this far in the frame (CSS px). */
const KEY_STEP_PX = 16

/**
 * Chrome's long screenshot (SH-08): the preview card's Capture more brought the whole page –
 * from its top, cut at about ten screens – and this sheet crops it. It is the phone's form of a
 * frame dialog whose body is the document (`openExpanded`): the picture stands in a frame at the
 * body's width, scaled so the first screen of it – what the viewport screenshot showed – fits the
 * body's height at the sheet's rest (`useSheetRest`: the expanded detent as it opens, the peek if
 * it is collapsed; one fit per detent, `fitScale`) with both handles in view, and the body
 * scrolls the rest (the sheet's own scroller; pulling down from its top collapses the sheet, as
 * everywhere). Two handles mark the crop's edges: §9.9's 32 × 4 grabber on a small panel pill
 * across an accent line, each on a 44 px band that is theirs alone (the press stops at the
 * band, so the chassis never mistakes a
 * handle's drag for its own), following the finger and pulling the picture along when it nears
 * the scroller's edge; what lies outside the crop is dimmed under the scrim. The handles are
 * sliders to the keyboard and TalkBack (the arrows move them a step). Share | Save are §9.11
 * peers in the footer, Save the primary (busy in the chassis's §9.30 form while the host
 * writes): the host crops the full-resolution picture it holds, saves it to the gallery and the
 * picture's own card follows; Share puts it on the OS's sheet as well. The sheet mounts with the
 * picture in hand: the host stitches the page from the window while the page is on screen and
 * alone in its frame, which a sheet over it would end (`openLongScreenshot`); a page that cannot
 * be captured is a toast, and no sheet.
 */
function LongScreenshotSheet({ editor }: { editor: LongScreenshotEditor }): JSX.Element {
  const capture = editor.capture
  // The crop the editor holds, in picture pixels, for the footer's buttons (written per move by
  // the layout below; state here would draw the whole sheet again on every frame of a drag).
  const cropRef = useRef<LongCaptureCrop | null>(null)
  const onCrop = useCallback((crop: LongCaptureCrop) => {
    cropRef.current = crop
  }, [])
  // The save takes the request with it and the sheet leaves on that (`SheetPresence`).
  const submit = (share: boolean): void => {
    const crop = cropRef.current
    if (crop) void saveLongScreenshot(crop, share)
  }
  return (
    <PhoneSheet
      name="long-screenshot"
      title={{ pose: 'header', text: 'Long screenshot' }}
      className="zen-longshot-sheet"
      onClose={closeLongScreenshot}
      contentKey={capture.id}
      openExpanded
      footer={
        <>
          <Btn data-testid="longshot-share" disabled={editor.busy} onClick={() => submit(true)}>
            Share
          </Btn>
          <Btn
            variant="primary"
            data-testid="longshot-save"
            busy={editor.busy}
            onClick={() => submit(false)}
          >
            Save
          </Btn>
        </>
      }
    >
      <CropEditor capture={capture} onCrop={onCrop} />
    </PhoneSheet>
  )
}

/**
 * The picture in its frame with the two handles. The crop is kept in picture pixels (what the
 * host crops), the handles drawn from it at the frame's scale; a drag writes it per move.
 */
function CropEditor({
  capture,
  onCrop
}: {
  capture: LongCapture
  onCrop: (crop: LongCaptureCrop) => void
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null)
  // The frame's scale, from the body's box at the sheet's rest: a new one when the chassis
  // measures the sheet again (the keyboard, a turn) or the sheet heads for its other detent,
  // and nothing while the sheet is in motion. Before the first measure, no frame.
  const rest = useSheetRest()
  const scale = rest ? fitScale(capture, rest) : 0
  // The first screen of the page, what the viewport screenshot showed, is the crop to start from.
  const [crop, setCrop] = useState<LongCaptureCrop>(() => ({
    top: 0,
    bottom: Math.min(capture.height, capture.viewportHeight)
  }))
  useEffect(() => onCrop(crop), [crop, onCrop])

  const frameWidth = Math.round(capture.width * scale)
  const frameHeight = Math.round(capture.height * scale)
  const topPx = Math.round(crop.top * scale)
  const bottomPx = Math.round(crop.bottom * scale)
  const minCrop = scale > 0 ? MIN_CROP_PX / scale : 1

  const move = (edge: 'top' | 'bottom', picturePx: number): void => {
    setCrop((c) => {
      if (edge === 'top') {
        const top = Math.round(Math.max(0, Math.min(c.bottom - minCrop, picturePx)))
        return top === c.top ? c : { ...c, top }
      }
      const bottom = Math.round(Math.min(capture.height, Math.max(c.top + minCrop, picturePx)))
      return bottom === c.bottom ? c : { ...c, bottom }
    })
  }

  /**
   * A handle's drag: the press is the handle's alone (`stopPropagation`: the chassis never sees
   * it, so a drag on a handle is never a drag of the sheet), captured to the handle, the edge
   * following the finger in picture pixels; near the scroller's edge the picture scrolls along.
   */
  const startDrag = (edge: 'top' | 'bottom') => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const handle = e.currentTarget
    const scroller = handle.closest<HTMLElement>('.zen-sheet-scroll')
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      // A pointer the browser is not tracking (a script's synthetic press) cannot be captured;
      // its moves still reach the handle they are sent to.
    }
    handle.dataset.dragging = 'true'
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return
      const rect = frame.current?.getBoundingClientRect()
      if (!rect || scale <= 0) return
      move(edge, (ev.clientY - rect.top) / scale)
      if (scroller) {
        const box = scroller.getBoundingClientRect()
        const above = box.top + EDGE_FOLLOW_PX - ev.clientY
        const below = ev.clientY - (box.bottom - EDGE_FOLLOW_PX)
        if (above > 0) scroller.scrollTop -= above
        else if (below > 0) scroller.scrollTop += below
      }
    }
    const onEnd = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return
      delete handle.dataset.dragging
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      // The click a press-and-release produces means nothing here (§9.9: the band is a grip).
      ev.stopPropagation()
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }

  const onKey = (edge: 'top' | 'bottom') => (e: KeyboardEvent<HTMLDivElement>) => {
    if (scale <= 0) return
    const step = KEY_STEP_PX / scale
    const at = edge === 'top' ? crop.top : crop.bottom
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(edge, at - step)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') move(edge, at + step)
    else if (e.key === 'Home') move(edge, edge === 'top' ? 0 : crop.top + minCrop)
    else if (e.key === 'End') move(edge, edge === 'top' ? crop.bottom - minCrop : capture.height)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const handle = (edge: 'top' | 'bottom', at: number): JSX.Element => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={edge === 'top' ? 'Top edge' : 'Bottom edge'}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={capture.height}
      aria-valuenow={edge === 'top' ? crop.top : crop.bottom}
      aria-valuetext={`${Math.round(((edge === 'top' ? crop.top : crop.bottom) / capture.viewportHeight) * 100) / 100} screens from the top`}
      className="zen-longshot-handle"
      data-edge={edge}
      data-testid={`longshot-handle-${edge}`}
      style={{ top: at }}
      onPointerDown={startDrag(edge)}
      onKeyDown={onKey(edge)}
    >
      <span className="zen-longshot-line" aria-hidden />
      <span className="zen-longshot-grip" aria-hidden>
        <span className="zen-sheet-handle" />
      </span>
    </div>
  )

  return (
    <div className="zen-longshot-body" data-testid="longshot-editor">
      <div
        ref={frame}
        className="zen-longshot-frame"
        style={scale > 0 ? { width: frameWidth, height: frameHeight } : undefined}
      >
        <div className="zen-longshot-picture">
          <img src={capture.preview} alt="" draggable={false} />
          <div className="zen-longshot-dim" style={{ top: 0, height: topPx }} aria-hidden />
          <div className="zen-longshot-dim" style={{ top: bottomPx, bottom: 0 }} aria-hidden />
        </div>
        {scale > 0 && handle('top', topPx)}
        {scale > 0 && handle('bottom', bottomPx)}
      </div>
      <div className="zen-longshot-caption" data-testid="longshot-size">
        {capture.width} × {crop.bottom - crop.top}
      </div>
    </div>
  )
}
