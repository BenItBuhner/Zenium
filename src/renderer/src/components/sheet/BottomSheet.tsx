import type { JSX, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { computeDetents, SheetMotion, type SheetDetents } from '@renderer/lib/motion/sheet'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

/**
 * Movement (px) before a touch on the body stops being a tap and its axis is decided. Kept
 * under the WebView's own scroll slop, so a downward pull on a list that sits at its top is
 * ours before the WebView starts a scroll it could not perform anyway.
 */
const SLOP = 6

export interface BottomSheetHandle {
  /** Slide the sheet off the screen; `then` runs once it is gone, right before `onDismissed`. */
  dismiss(then?: () => void): void
  /** Predictive back: pull the sheet down by `progress` (0 = resting, 1 = as far as the preview goes). */
  backProgress(progress: number): void
  /** The back gesture completed: finish the dismissal from wherever the preview left the sheet. */
  commitBack(): void
  /** The back gesture was abandoned: spring back to the resting detent. */
  cancelBack(): void
}

interface Props {
  ref?: Ref<BottomSheetHandle>
  /** The sheet has left the screen – by drag, fling, scrim tap, back gesture or `dismiss`. */
  onDismissed: () => void
  /** Non-scrolling content under the handle (a title row); part of the grip. */
  header?: ReactNode
  /** The scrolling body. */
  children: ReactNode
  /** Change it when the body is swapped, so the detents are measured again. */
  contentKey?: string
  /** Accessible name of the handle. */
  handleLabel?: string
  /**
   * Fade the body's scroll edges (the default). A sheet that marks scrolled content with a line
   * under its header instead (`data-scrolled` on the sheet) turns this off.
   */
  fadeEdges?: boolean
  className?: string
}

type Zone = 'grip' | 'body' | 'scrim'
type Mode = 'pending' | 'sheet' | 'none'

interface Touch {
  id: number
  x0: number
  y0: number
  zone: Zone
  mode: Mode
  /** The touch grabbed a moving sheet: never a tap. */
  caught: boolean
  tracker: VelocityTracker
}

/**
 * Feed a move event to the tracker – including the samples the browser coalesced into it while
 * the main thread was busy, so a fling is measured from the real finger path.
 */
function track(tracker: VelocityTracker, e: ReactPointerEvent<HTMLElement>): void {
  const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }
  const coalesced = native.getCoalescedEvents?.() ?? []
  if (coalesced.length > 0) {
    for (const c of coalesced) tracker.add(c.timeStamp, c.clientX, c.clientY)
  } else {
    tracker.add(e.timeStamp, e.clientX, e.clientY)
  }
}

/**
 * A bottom sheet with a peek and an expanded detent, on the `SheetMotion` the site-information
 * sheet runs on. It springs up to the peek (about half the screen; a short sheet simply shows
 * all of itself) and is dragged by its handle, its title row or its body: up to expand, down to
 * collapse or fling away. Release velocity picks the detent, a finger landing during any motion
 * catches the sheet where it is, the scrim fades with the sheet's position, and content never
 * jumps – between detents the sheet changes height with its content anchored to the top edge,
 * below the peek it slides down whole. The motion writes to the DOM straight from its frames;
 * React only renders the content.
 *
 * The body scrolls natively only while the sheet rests expanded; pulling down on a body that
 * sits at its top drags the sheet instead. Everything else (Escape, system back, a picked item)
 * goes through `dismiss`, and the `back*` methods let a predictive back gesture drive the same
 * motion.
 */
export function BottomSheet({
  ref,
  onDismissed,
  header,
  children,
  contentKey,
  handleLabel = 'Resize sheet',
  fadeEdges = true,
  className
}: Props): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fadeRef = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  const touch = useRef<Touch | null>(null)
  const swallowClick = useRef(false)
  const detents = useRef<SheetDetents>({ collapsed: 0, expanded: 0 })
  const insetTop = useRef(0)
  /** Runs once a dismissal has finished (a picked row's action). A catch drops it. */
  const afterDismiss = useRef<(() => void) | null>(null)
  /** The window changed size while the page stood receded behind the sheet. */
  const resizedWhileUp = useRef(false)
  const latest = useRef({ onDismissed })
  const insets = uiStore.use((s) => s.insets)

  // The motion lives in a ref and is only ever touched from effects and event handlers.
  const motionRef = useRef<SheetMotion | null>(null)
  const motion = (): SheetMotion =>
    (motionRef.current ??= new SheetMotion({
      detents: () => detents.current,
      onChange: () => {
        const sheet = sheetRef.current
        const scrim = scrimRef.current
        if (!sheet || !scrim) return
        const frame = motionRef.current!.frame()
        sheet.style.height = `${frame.height}px`
        sheet.style.transform = `translate3d(0, ${frame.translateY}px, 0)`
        // The scrim's colour and full opacity are the `--zen-scrim` token's; only its share moves.
        scrim.style.opacity = frame.scrim.toFixed(4)
        // The page behind recedes and the bottom bar fades with the same progress (main.css).
        document.documentElement.style.setProperty('--zen-recede', frame.scrim.toFixed(4))
        syncLock()
      },
      onClosed: () => {
        const then = afterDismiss.current
        afterDismiss.current = null
        then?.()
        latest.current.onDismissed()
      }
    }))

  /** Native scrolling only while the sheet rests fully expanded; otherwise every pan is a sheet drag. */
  const syncLock = (): void => {
    const locked = !motion().restingExpanded || touch.current?.mode === 'sheet'
    sheetRef.current?.setAttribute('data-locked', String(locked))
  }

  const measure = (): void => {
    const layer = layerRef.current
    const sheet = sheetRef.current
    if (!layer || !sheet) return
    // Let the sheet size itself to its content for one synchronous layout, then take over again.
    const height = sheet.style.height
    sheet.style.height = 'auto'
    const intrinsic = sheet.offsetHeight
    sheet.style.height = height
    detents.current = computeDetents(intrinsic, layer.clientHeight, insetTop.current)
    const m = motion()
    if (m.isOpen) m.refresh()
    else m.present()
    sheet.style.visibility = 'visible'
  }

  // The header shows its hairline once the body has scrolled under it, and loses it at the top
  // (design language v2 §9.7); every sheet gets this from the chassis.
  useEffect(() => {
    const sc = scrollRef.current
    const sheetEl = sheetRef.current
    if (!sc || !sheetEl) return
    const sync = (): void => {
      sheetEl.dataset.scrolled = String(sc.scrollTop > 0)
    }
    sync()
    sc.addEventListener('scroll', sync, { passive: true })
    return () => sc.removeEventListener('scroll', sync)
  }, [])
  useEffect(() => {
    latest.current = { onDismissed }
  })

  useLayoutEffect(() => {
    insetTop.current = insets.top
    // New content starts at its top; the old scroll offset belonged to what was there before.
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the content or the insets change
  }, [contentKey, insets.top, insets.bottom])

  // The sheet says when its content has scrolled under the header (`data-scrolled`), so a
  // stylesheet can draw a line there; the chassis itself shows nothing for it.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const update = (): void => {
      const sheet = sheetRef.current
      if (!sheet) return
      if (scroller.scrollTop > 0) sheet.setAttribute('data-scrolled', 'true')
      else sheet.removeAttribute('data-scrolled')
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [])

  // The layer shrinks when the keyboard comes up and grows back; the detents follow.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer || typeof ResizeObserver !== 'function') return
    let last = layer.clientHeight
    const observer = new ResizeObserver(() => {
      if (layer.clientHeight === last) return
      last = layer.clientHeight
      resizedWhileUp.current = true
      measure()
    })
    observer.observe(layer)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the observer reads the latest refs
  }, [])

  // The content frame is promoted while a sheet is up, and released – with the recede – after.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.receding = 'true'
    return () => {
      delete root.dataset.receding
      root.style.removeProperty('--zen-recede')
      // The layout reporter measures the content frame on resize; a measurement taken while the
      // frame stood receded is 3 % small, so have it look again now that the frame is back.
      if (resizedWhileUp.current) window.dispatchEvent(new Event('resize'))
    }
  }, [])

  // The WebView must not turn a pull on the body into a scroll once the sheet has taken it.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const onTouchMove = (e: TouchEvent): void => {
      const t = touch.current
      if (!t) return
      if (t.mode === 'sheet') {
        if (e.cancelable) e.preventDefault()
      } else if (t.mode === 'pending' && !e.cancelable) {
        // Too late: the WebView is already scrolling the body.
        t.mode = 'none'
      }
    }
    layer.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => layer.removeEventListener('touchmove', onTouchMove)
  }, [])

  // Unmounted mid-motion (the host hid the menu): stop the spring without reporting a close.
  useEffect(
    () => () => {
      const m = motionRef.current
      if (!m) return
      afterDismiss.current = null
      latest.current = { onDismissed: () => undefined }
      m.close()
    },
    []
  )

  const dismiss = (then?: () => void): void => {
    const m = motion()
    if (!m.isOpen) return
    if (then) afterDismiss.current = then
    m.dismiss()
  }

  useImperativeHandle(
    ref,
    () => ({
      dismiss,
      backProgress: (progress) => {
        if (!touch.current) motion().backProgress(progress)
      },
      commitBack: () => motion().backCommit(),
      cancelBack: () => motion().backCancel()
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handle only reaches through refs
    []
  )

  const beginDrag = (t: Touch, e: ReactPointerEvent<HTMLDivElement>): void => {
    t.mode = 'sheet'
    t.caught = true
    t.y0 = e.clientY
    // Whatever the motion was about to do (a pick, a dismissal) is off: the finger decides now.
    afterDismiss.current = null
    motion().beginDrag()
    // Captured only now: a capture from pointerdown on would retarget the click of a plain tap
    // away from the row that was tapped.
    capturePointer(e.currentTarget, e.pointerId)
    sheetRef.current?.setAttribute('data-dragging', 'true')
    syncLock()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || touch.current) return
    const target = e.target as HTMLElement
    const zone: Zone = !sheetRef.current?.contains(target)
      ? 'scrim'
      : target.closest('[data-sheet-grip]')
        ? 'grip'
        : 'body'
    // A drag produces no click to swallow; a new touch must start with a clean slate.
    swallowClick.current = false
    const moving = motion().current.phase === 'settling'
    // A resting sheet's scrim is only a tap target.
    if (!moving && zone === 'scrim') return
    const tracker = new VelocityTracker()
    tracker.add(e.timeStamp, e.clientX, e.clientY)
    const t: Touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      zone,
      mode: 'pending',
      caught: moving,
      tracker
    }
    touch.current = t
    // A finger that caught the sheet mid-flight holds it: the drag is on from the first move.
    if (moving) beginDrag(t, e)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    track(t.tracker, e)
    if (t.mode === 'pending') {
      const dx = e.clientX - t.x0
      const dy = e.clientY - t.y0
      if (Math.abs(dy) < SLOP && Math.abs(dx) < SLOP) return
      if (Math.abs(dx) > Math.abs(dy)) {
        t.mode = 'none'
        return
      }
      // The grip always drags. The body drags too, unless it is a list at rest on the expanded
      // detent with room to scroll the way the finger goes – then the WebView scrolls it.
      const atTop = (scrollRef.current?.scrollTop ?? 0) <= 0
      if (t.zone === 'grip' || !motion().restingExpanded || (dy > 0 && atTop)) beginDrag(t, e)
      else {
        t.mode = 'none'
        return
      }
    }
    if (t.mode !== 'sheet') return
    // The track counts towards dismissal; the finger's y runs down the screen too.
    motion().drag(e.clientY - t.y0)
  }

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    sheetRef.current?.removeAttribute('data-dragging')
    if (t.mode !== 'sheet') {
      if (t.caught) swallowClick.current = true
      syncLock()
      return
    }
    swallowClick.current = true
    const { vy } = cancelled ? { vy: 0 } : t.tracker.velocity(e.timeStamp)
    motion().release(vy)
    syncLock()
  }

  /** The handle as a button: a tap moves to the other detent, or closes a sheet that has only one. */
  const onHandleTap = (): void => {
    const m = motion()
    const { collapsed, expanded } = detents.current
    if (collapsed === expanded) {
      dismiss()
      return
    }
    m.settleTo(m.restingDetent === 'expanded' ? 'collapsed' : 'expanded')
  }

  return (
    // A page surface (design language v2 §9.29): the sheet's controls draw in the page family.
    <div
      ref={layerRef}
      className="fixed inset-0 z-[90]"
      data-surface="page"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onClickCapture={(e) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        ref={scrimRef}
        className="zen-sheet-scrim absolute inset-0"
        style={{ opacity: 0 }}
        onClick={() => dismiss()}
      />
      <div
        ref={sheetRef}
        role="dialog"
        className={cn(
          'zen-sheet zen-sheet-detents absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-[520px] flex-col',
          className
        )}
        style={{ paddingBottom: Math.max(8, insets.bottom), visibility: 'hidden' }}
        data-locked="true"
        data-surface="page"
      >
        <div data-sheet-grip className="zen-sheet-grip shrink-0">
          <button
            type="button"
            className="zen-sheet-handle-hit"
            aria-label={handleLabel}
            onClick={onHandleTap}
          >
            <span className="zen-sheet-handle" />
          </button>
          {header && <div className="zen-sheet-header">{header}</div>}
        </div>
        <div
          ref={(el) => {
            scrollRef.current = el
            return fadeEdges ? fadeRef(el) : undefined
          }}
          className="zen-sheet-scroll min-h-0 flex-1 overflow-y-auto"
        >
          {children}
        </div>
      </div>
    </div>
  )
}
