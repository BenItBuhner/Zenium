import type { JSX, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import {
  computeDetents,
  settleDetent,
  sheetBackPosition,
  sheetDragPosition,
  sheetFrame,
  type SheetDetents
} from '@renderer/lib/gestures/sheet'
import { SpringAnimation, type SpringConfig } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

/** Open, close and settle: soft, with a hair of overshoot so a detent reads as a place the sheet came to rest (ζ ≈ 0.92). */
const SPRING_SHEET: SpringConfig = {
  stiffness: 340,
  damping: 34,
  mass: 1,
  restDelta: 0.4,
  restSpeed: 8
}
/** Opacity of the scrim behind a sheet at (or above) its peek detent. */
const SCRIM_OPACITY = 0.42
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
  className?: string
}

type Detent = 'collapsed' | 'expanded'

/**
 * The sheet's motion, kept out of React because it changes every frame: one position on the
 * track (visible height in px), the spring that carries it between detents, and the DOM writes
 * that show it. Stopping the spring hands the live position to a finger, which is what makes
 * every transition catchable.
 */
class SheetMotion {
  position = 0
  detents: SheetDetents = { collapsed: 0, expanded: 0 }
  /** Detent the sheet rests at, or is heading for. */
  resting: Detent = 'collapsed'
  /** Where the sheet stood when a predictive back gesture took hold of it. */
  backOrigin: number | null = null
  /** Status-bar inset (px) the expanded sheet keeps clear. */
  insetTop = 0
  sheet: HTMLElement | null = null
  scrim: HTMLElement | null = null
  onDismissed: (() => void) | null = null
  /** The sheet came to rest on a detent. */
  onRest: (() => void) | null = null
  private target = 0
  private afterDismiss: (() => void) | null = null
  private readonly spring = new SpringAnimation(
    SPRING_SHEET,
    (x) => this.apply(x),
    () => this.rest()
  )

  get running(): boolean {
    return this.spring.running
  }

  get dismissing(): boolean {
    return this.spring.running && this.target === 0
  }

  /** At rest on the expanded detent: the only state in which the body scrolls natively. */
  get restingExpanded(): boolean {
    return !this.spring.running && this.position >= this.detents.expanded - 1
  }

  /** Lay the sheet out at `position` px of visible height. */
  apply(position: number): void {
    this.position = position
    if (!this.sheet || !this.scrim) return
    const frame = sheetFrame(position, this.detents)
    this.sheet.style.height = `${frame.height}px`
    this.sheet.style.transform = `translate3d(0, ${frame.translateY}px, 0)`
    this.scrim.style.opacity = `${frame.scrim * SCRIM_OPACITY}`
  }

  /** Head for `target` px with the spring, carrying `velocity` px/s. */
  settleTo(target: number, velocity = 0): void {
    this.target = target
    this.backOrigin = null
    this.afterDismiss = null
    // A sheet with one detent keeps the intent it had; only a real choice changes it.
    if (target > 0 && this.detents.collapsed !== this.detents.expanded)
      this.resting = target >= this.detents.expanded ? 'expanded' : 'collapsed'
    this.spring.start(this.position, velocity, target)
  }

  /** Slide off the screen, then run `then` (a picked menu item) and report the dismissal. */
  dismiss(then?: () => void, velocity = 0): void {
    this.settleTo(0, velocity)
    this.afterDismiss = then ?? null
  }

  /** A finger landed while the sheet was moving: freeze it there. Returns false when it was at rest. */
  catch(): boolean {
    if (!this.spring.running) return false
    this.spring.stop()
    // Whatever the motion was about to do (a pick, a dismissal) is off: the finger decides now.
    this.afterDismiss = null
    this.backOrigin = null
    return true
  }

  /** The detents changed (first measurement, new content, a resize): follow them. */
  remeasured(detents: SheetDetents, first: boolean): void {
    this.detents = detents
    this.apply(this.position)
    if (first) {
      this.resting = 'collapsed'
      this.settleTo(detents.collapsed)
      return
    }
    if (this.dismissing) return
    const to = detents[this.resting]
    if (this.spring.running) {
      this.target = to
      this.spring.retarget(to)
    } else if (this.position !== to) {
      this.settleTo(to)
    }
  }

  backProgress(progress: number): void {
    if (this.dismissing) return
    if (this.backOrigin === null) {
      if (this.spring.running) this.spring.stop()
      this.backOrigin = this.position
    }
    this.apply(sheetBackPosition(this.backOrigin, progress))
  }

  commitBack(): void {
    this.dismiss()
  }

  cancelBack(): void {
    if (this.backOrigin === null) return
    const origin = this.backOrigin
    this.backOrigin = null
    this.settleTo(origin)
  }

  destroy(): void {
    this.spring.stop()
    this.afterDismiss = null
  }

  private rest(): void {
    if (this.target === 0) {
      const then = this.afterDismiss
      this.afterDismiss = null
      then?.()
      this.onDismissed?.()
      return
    }
    this.onRest?.()
  }
}

type Zone = 'grip' | 'body' | 'scrim'
type Mode = 'pending' | 'sheet' | 'none'

interface Touch {
  id: number
  x0: number
  y0: number
  zone: Zone
  mode: Mode
  /** Sheet position when the drag began. */
  dragStart: number
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
 * A bottom sheet that is a real object on the screen. It springs up to a peek detent (about
 * half the screen; a short sheet simply shows all of itself) and is dragged by its handle, its
 * title row or its body: up to expand, down to collapse or fling away. Release velocity picks
 * the detent, a finger landing during any motion catches the sheet where it is, the scrim fades
 * with the sheet's position, and content never jumps – between detents the sheet changes height
 * with its content anchored to the top edge, below the peek it slides down whole.
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
  className
}: Props): JSX.Element {
  // The motion lives in a ref and is only ever touched from effects and event handlers.
  const motionRef = useRef<SheetMotion | null>(null)
  const motion = (): SheetMotion => (motionRef.current ??= new SheetMotion())
  const layerRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fadeRef = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  const touch = useRef<Touch | null>(null)
  const swallowClick = useRef(false)
  const measured = useRef(false)
  const insets = uiStore.use((s) => s.insets)

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
    const first = !measured.current
    measured.current = true
    const m = motion()
    m.remeasured(computeDetents(intrinsic, layer.clientHeight, m.insetTop), first)
    sheet.style.visibility = 'visible'
    syncLock()
  }

  useEffect(() => {
    const m = motion()
    m.onDismissed = onDismissed
    m.onRest = syncLock
  })

  useLayoutEffect(() => {
    const m = motion()
    m.sheet = sheetRef.current
    m.scrim = scrimRef.current
    m.insetTop = insets.top
    // New content starts at its top; the old scroll offset belonged to what was there before.
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the content or the insets change
  }, [contentKey, insets.top, insets.bottom])

  // The layer shrinks when the keyboard comes up and grows back; the detents follow.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer || typeof ResizeObserver !== 'function') return
    let last = layer.clientHeight
    const observer = new ResizeObserver(() => {
      if (layer.clientHeight === last) return
      last = layer.clientHeight
      measure()
    })
    observer.observe(layer)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the observer reads the latest refs
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

  useEffect(() => () => motion().destroy(), [])

  useImperativeHandle(
    ref,
    () => ({
      dismiss: (then) => motion().dismiss(then),
      backProgress: (progress) => {
        if (!touch.current) motion().backProgress(progress)
      },
      commitBack: () => motion().commitBack(),
      cancelBack: () => motion().cancelBack()
    }),
    []
  )

  const beginDrag = (t: Touch, e: ReactPointerEvent<HTMLDivElement>): void => {
    t.mode = 'sheet'
    t.caught = true
    t.y0 = e.clientY
    t.dragStart = motion().position
    // Captured only now: a capture from pointerdown on would retarget the click of a plain tap
    // away from the row that was tapped.
    e.currentTarget.setPointerCapture(e.pointerId)
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
    const m = motion()
    const caught = m.catch()
    // A resting sheet's scrim is only a tap target.
    if (!caught && zone === 'scrim') return
    const tracker = new VelocityTracker()
    tracker.add(e.timeStamp, e.clientX, e.clientY)
    const t: Touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      zone,
      mode: 'pending',
      dragStart: m.position,
      caught,
      tracker
    }
    touch.current = t
    // A finger that caught the sheet mid-flight holds it: the drag is on from the first move.
    if (caught) beginDrag(t, e)
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
    const m = motion()
    m.apply(sheetDragPosition(t.dragStart, t.y0 - e.clientY, m.detents))
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
    // The track runs upwards; the finger's y runs down the screen.
    const velocity = -vy
    const m = motion()
    const target = settleDetent(m.position, velocity, m.detents)
    if (target === 0) m.dismiss(undefined, velocity)
    else m.settleTo(target, velocity)
    syncLock()
  }

  /** The handle as a button: a tap moves to the other detent, or closes a sheet that has only one. */
  const onHandleTap = (): void => {
    const m = motion()
    const { collapsed, expanded } = m.detents
    if (collapsed === expanded) {
      m.dismiss()
      return
    }
    m.settleTo(m.resting === 'expanded' ? collapsed : expanded)
    syncLock()
  }

  return (
    <div
      ref={layerRef}
      className="fixed inset-0 z-[90]"
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
        onClick={() => motion().dismiss()}
      />
      <div
        ref={sheetRef}
        role="dialog"
        className={cn(
          'zen-sheet absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-[520px] flex-col',
          className
        )}
        style={{ paddingBottom: Math.max(8, insets.bottom), visibility: 'hidden' }}
        data-locked="true"
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
          {header}
        </div>
        <div
          ref={(el) => {
            scrollRef.current = el
            return fadeRef(el)
          }}
          className="zen-sheet-scroll min-h-0 flex-1 overflow-y-auto"
        >
          {children}
        </div>
      </div>
    </div>
  )
}
