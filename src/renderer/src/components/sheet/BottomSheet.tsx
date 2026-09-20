import type { JSX, PointerEvent as ReactPointerEvent, ReactNode, Ref, SyntheticEvent } from 'react'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import {
  registerRecedeLayer,
  type RecedeHandle,
  type RecedeLayerFrame
} from '@renderer/lib/motion/recede'
import { useSheetLeave } from '@renderer/lib/motion/presence'
import {
  computeDetents,
  detentForField,
  fieldOverflow,
  REDUCED_MOTION_FADE_MS,
  SheetMotion,
  type SheetDetents
} from '@renderer/lib/motion/sheet'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { isTextField, sheetInitialFocus, wrapTab } from '@renderer/lib/popover'
import { holdChromeInert } from '@renderer/lib/portals'
import { coverPageUnderSheet, uiStore, type SheetCover } from '@renderer/lib/ui'
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
  /**
   * The sheet has left the screen – by drag, fling, scrim tap, back gesture or `dismiss` – and
   * its request is still standing: the surface clears it. Not called for a sheet leaving because
   * its request has gone already (`SheetPresence`): that leave answers the wrapper's `onLeft`.
   */
  onDismissed: () => void
  /** Non-scrolling content under the handle (a title row); part of the grip. */
  header?: ReactNode
  /** The scrolling body. */
  children: ReactNode
  /**
   * The sheet's actions under the body (`.zen-sheet-footer`, §9.11: peers split the width, the
   * primary trailing), outside the scroller so they stay in reach at every detent.
   */
  footer?: ReactNode
  /** Change it when the body is swapped, so the detents are measured again. */
  contentKey?: string
  /** Accessible name of the handle. */
  handleLabel?: string
  /**
   * Fade the body's bottom edge while more content lies past it (the default). The header's
   * edge never fades: every sheet marks content scrolled under its header with the hairline
   * (`data-scrolled` on the sheet, v2 §9.7), not a fade. `false` turns the bottom fade off too.
   */
  fadeEdges?: boolean
  /** The id of the element that names the dialog (its title), for `aria-labelledby`. */
  labelledBy?: string
  /**
   * The dialog's name where no element on it says it (a menu sheet with no title row): TalkBack
   * announces a dialog by its name as it opens, and an unnamed one is "dialog" and nothing more.
   */
  label?: string
  className?: string
  /**
   * Rendered inside a `FrameDialogHost` (lib/portals.tsx): the layer fills the host's box
   * (`absolute`) instead of the viewport (`fixed`), and the host orders the stack.
   */
  hosted?: boolean
  /**
   * Measure the detents again whenever the header or the body changes size – a form that
   * arrives after the sheet is up, a country with more lines, a validation line – so the sheet
   * follows its content instead of holding the height it opened at (the scroll offset stays).
   */
  fitContent?: boolean
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
 * The control each mounted sheet returns focus to when it goes (§9.22), by its layer, in mount
 * order – the recede stack's. A sheet going from under another hands its opener up: a sheet
 * above it whose opener lies inside it (a menu popping over an open one finds a row of the one
 * on its way out focused) or whose opener was nothing (that row already blurred as it went
 * inert) takes it, so that when the sheet above goes in its turn, focus comes back to the
 * control that opened the first, not to nothing.
 */
const openers = new Map<HTMLElement, { current: HTMLElement | null }>()

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
 * The sheet is on the recede chassis (`lib/motion/recede.ts`, v2 draft §11): the page behind
 * recedes and the bottom bar fades on the sheet's own progress, reversibly, and a sheet mounted
 * over another recedes the lower one and makes it inert – nothing to opt into. The sheet holds
 * the page under its cover for as long as anything of it shows (`coverPageUnderSheet`, §11.7):
 * where the chrome lies under the pages it comes up only once the live page has given way to its
 * picture, so the recede never starts on a page that is about to be swapped, and the page comes
 * back only once the sheet has landed, whoever closed it.
 *
 * Its leave outlives its request (§11.1, `SheetPresence` in lib/motion/presence.tsx): rendered
 * under the wrapper, a sheet whose request the store has cleared – a host-driven close, or the
 * surface's own write once `onDismissed` ran – is told it is `leaving` and runs its own
 * dismissal from wherever it stands – the same `dismiss` as the surface's, so the 120 ms fade
 * under reduced motion is the one check and the one length (`reducedMotion`,
 * `REDUCED_MOTION_FADE_MS`) – p 1 → 0 over its travel on the sheet spring, `inert` and
 * `aria-hidden` from the commit that took its request and taking the pointer on its scrim
 * throughout (§11.2, Leaving), and answers the wrapper's `onLeft` once landed, which is when it
 * unmounts: the layer leaves the stack, the chrome and the page come back and focus returns to
 * the opener then, not at the store write. A finger catching a leaving sheet holds it; the leave
 * resumes with the finger's velocity when it lets go. A back gesture over a leaving sheet is
 * absorbed: it is on its way already.
 *
 * The body scrolls natively only while the sheet rests expanded; pulling down on a body that
 * sits at its top drags the sheet instead. Everything else (Escape, system back, a picked item)
 * goes through `dismiss`, and the `back*` methods let a predictive back gesture drive the same
 * motion. A press on the scrim dismisses on `pointerdown` (§9.20).
 *
 * The keyboard (v2 draft §9.22, §9.24) is the chassis's too, so every sheet has it: as the sheet
 * opens, focus moves into it – the checked option, else the first row or control that is not a
 * text field, else the dialog itself (`sheetInitialFocus`; a surface that wants another element
 * focuses it from its own effect, which runs after this one and wins) – and moves in again when
 * the content is swapped from under it; Tab wraps inside the sheet; the chrome behind the scrim
 * is inert while the sheet is up (`holdChromeInert`, the one mechanism the frame dialog host
 * uses); and when the sheet has gone, focus returns to the control that opened it – a sheet
 * going from under another hands that control up to it (`openers`), so a stack unwound from
 * the top, or a menu that popped over a leaving one, still ends on the control that opened the
 * first. Escape is the surface's (`useEscape`), since some sheets step back a level before
 * they close.
 */
export function BottomSheet({
  ref,
  onDismissed,
  header,
  children,
  footer,
  contentKey,
  handleLabel = 'Resize sheet',
  fadeEdges = true,
  labelledBy,
  label,
  className,
  hosted = false,
  fitContent = false
}: Props): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gripRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // The bottom edge only: the header's hairline (`data-scrolled`) marks scrolled-under content (§9.7).
  const fadeRef = useFadeEdges<HTMLDivElement>({ axis: 'y', edges: 'end' })
  /**
   * The body's ref, one for the life of the sheet. A ref that changes identity is detached and
   * attached again on every render, and `attachFadeEdges` observes the body afresh each time
   * with a new ResizeObserver. The sheet renders on every frame of the keyboard's lift (the
   * insets), some of them in a sync flush inside a resize delivery (the layout reporter's
   * callback, the content frame shrinking under the keyboard): a body observed anew from there,
   * at the frame's own depth, is a notification that delivery can no longer reach, and the
   * WebView logs `ResizeObserver loop limit exceeded` for it – once per such frame.
   */
  const bodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el
      return fadeEdges ? fadeRef(el) : undefined
    },
    [fadeEdges, fadeRef]
  )
  const touch = useRef<Touch | null>(null)
  const swallowClick = useRef(false)
  const detents = useRef<SheetDetents>({ collapsed: 0, expanded: 0 })
  const insetTop = useRef(0)
  /** The gesture bar, or the keyboard while it is up: the detents are measured above it. */
  const insetBottom = useRef(0)
  /** Runs once a dismissal has finished (a picked row's action). A catch drops it. */
  const afterDismiss = useRef<(() => void) | null>(null)
  /** The window changed size while the page stood receded behind the sheet. */
  const resizedWhileUp = useRef(false)
  const leave = useSheetLeave()
  const leaving = leave?.leaving ?? false
  /** The request has gone (`SheetPresence`): the sheet is on its way out and answers `onLeft`. */
  const leavingRef = useRef(false)
  const latest = useRef({ onDismissed, onLeft: leave?.onLeft })
  const insets = uiStore.use((s) => s.insets)
  /** This sheet's layer on the recede stack, for as long as it is mounted. */
  const recede = useRef<RecedeHandle | null>(null)
  /** What the stack says about this sheet: how far it recedes under a sheet above, its scrim's share. */
  const layerFrame = useRef<RecedeLayerFrame>({ recede: 0, scrim: 0, inert: false })
  /** No sheet above this one on the stack: it holds the focus and answers the keyboard (§9.24). */
  const onTop = (): boolean => recede.current?.onTop() ?? false
  /**
   * The page's cover, held from before the sheet comes up (the wait for the live page to give
   * way to its picture) until the sheet unmounts, once it has landed; null before the first
   * presentation and once let go of.
   */
  const cover = useRef<SheetCover | null>(null)
  /** The wait for the cover is over (the sheet came up, or went before it could): no second one. */
  const presented = useRef(false)
  /**
   * Under reduced motion a departure is a 120 ms fade in place (§11.3): the sheet and its scrim
   * go to 0 on main.css's transition, and the spring's jump off the screen follows the fade.
   * Cleared by a finger catching the sheet before the jump, or by the unmount.
   */
  const fade = useRef<number | null>(null)

  // The motion lives in a ref and is only ever touched from effects and event handlers.
  const motionRef = useRef<SheetMotion | null>(null)

  /**
   * Write the frame: the motion's geometry and the stack's recede together. Position and recede
   * share `transform`; the scale is the chassis rule in main.css (`--zen-layer-scale`), fed the
   * upper sheet's progress through `--zen-layer-recede`, which also grows the top corners.
   */
  const paint = (): void => {
    const sheet = sheetRef.current
    const scrim = scrimRef.current
    const m = motionRef.current
    if (!sheet || !scrim || !m) return
    const frame = m.frame()
    const layer = layerFrame.current
    sheet.style.height = `${frame.height}px`
    sheet.style.transform = `translate3d(0, ${frame.translateY}px, 0) scale(var(--zen-layer-scale, 1))`
    sheet.style.setProperty('--zen-layer-recede', layer.recede.toFixed(4))
    // Under another sheet the content takes no input (§9.24); the sheet above owns the gesture.
    // A leaving sheet takes none either, to its unmount (§11.2, Leaving) – its layer still takes
    // the pointer, on the scrim, and a finger that caught it holds it by the layer's capture.
    // The sheet is promoted only while it stands recessed (main.css `data-recessed`).
    sheet.toggleAttribute('inert', layer.inert || leavingRef.current)
    sheet.toggleAttribute('data-recessed', layer.inert)
    layerRef.current?.toggleAttribute('data-leaving', leavingRef.current)
    // The scrim's colour and full opacity are the token's; its share is the sheet's progress as
    // the stack hands it out – given up to a sheet above as that fades its own in, so the stack
    // shows one scrim (the registry reports it from the presence the motion gave it above).
    // While a reduced-motion departure fades the scrim out, a frame from the stack (another
    // sheet moving) leaves that fade alone.
    if (fade.current === null) scrim.style.opacity = layer.scrim.toFixed(4)
    syncLock()
  }
  const motion = (): SheetMotion =>
    (motionRef.current ??= new SheetMotion({
      detents: () => detents.current,
      onChange: () => {
        // The page behind recedes and the bottom bar fades with the same progress, through the
        // chassis (`--zen-recede`, main.css); a sheet above recedes this one by its own.
        recede.current?.progress(motionRef.current!.frame().scrim)
        paint()
      },
      onClosed: () => landed()
    }))

  /**
   * The sheet is gone from the screen: a picked row's action runs, and the surface hears of it –
   * unless the request went first (`leaving`), in which case the wrapper that kept the sheet for
   * its leave hears `onLeft` and drops it; the surface made its write already.
   */
  const landed = (): void => {
    const then = afterDismiss.current
    afterDismiss.current = null
    then?.()
    if (leavingRef.current) latest.current.onLeft?.()
    else latest.current.onDismissed()
  }

  /** Native scrolling only while the sheet rests fully expanded; otherwise every pan is a sheet drag. */
  const syncLock = (): void => {
    const locked = !motion().restingExpanded || touch.current?.mode === 'sheet'
    sheetRef.current?.setAttribute('data-locked', String(locked))
  }

  /**
   * Take the page's cover and bring the sheet up once the live page is off the screen (at once
   * where nothing has to be waited for). Until then the sheet is laid out but held at `opacity:
   * 0` – not `visibility: hidden`, which takes no focus: the focus moves into the sheet as it
   * mounts (§9.22), by the chassis or by the surface's own effect, and has to land while the
   * hold lasts – and takes no press (a tap on it falls to the scrim, the dismissal, as it does
   * on the frame dialog host at progress 0), so that a sheet never recedes a page that is about
   * to be replaced by its picture – the swap would show. Escape, back or a dismissal during the
   * wait take the sheet down without a slide. The cover is held until the sheet unmounts, once
   * it has landed: the page comes back at the transform it left at, whoever closed the sheet.
   */
  const present = (): void => {
    if (cover.current || presented.current) return
    const c = coverPageUnderSheet()
    cover.current = c
    void c.promise.then(() => {
      if (cover.current !== c || presented.current) return
      presented.current = true
      const m = motion()
      if (m.isOpen) return
      m.present()
      const sheet = sheetRef.current
      if (sheet) {
        sheet.style.pointerEvents = ''
        // Below the screen at this frame, the step to full opacity shows nothing; under reduced
        // motion the spring has jumped it into place and main.css fades it in over 120 ms (§11.3).
        sheet.style.opacity = '1'
      }
    })
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
    detents.current = computeDetents(
      intrinsic,
      layer.clientHeight,
      insetTop.current,
      insetBottom.current
    )
    const m = motion()
    if (m.isOpen) m.refresh()
    else present()
  }

  /**
   * A focused field stays above the keyboard: when the bottom inset changes (the keyboard came
   * up, or grew) or a field in the sheet takes focus, the sheet expands if the field would sit
   * under the keys at the detent it rests at, and the body scrolls the rest of the way. The
   * field's place is measured from the sheet's top edge, which the content is anchored to, so a
   * spring still running does not enter into it; the body's scroll offset is set for the height
   * the sheet is heading for and holds as it grows.
   */
  const keepFieldInView = (): void => {
    const sheet = sheetRef.current
    const sc = scrollRef.current
    const active = document.activeElement
    if (!sheet || !sc || !active || !sheet.contains(active) || !isTextField(active)) return
    const m = motion()
    if (!m.isOpen || m.dismissing || touch.current) return
    const inset = insetBottom.current
    const fieldBottom = active.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top
    const detent = detentForField(fieldBottom, detents.current, inset, m.restingDetent)
    if (detent !== m.restingDetent) m.settleTo(detent)
    const overflow = fieldOverflow(fieldBottom, detents.current[detent], inset)
    if (overflow > 0) sc.scrollTop += overflow
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
  useLayoutEffect(() => {
    latest.current = { onDismissed, onLeft: leave?.onLeft }
  })
  // The request went (§11.1): in this very commit, before the first frame of its leave paints,
  // the sheet is inert and hidden from assistive technology – a screen reader never lands on a
  // sheet on its way out – and stays so to its unmount, a finger holding it or not (§11.2,
  // Leaving; `leaving` never goes back for a generation). `paint` keeps `inert` from here on.
  useLayoutEffect(() => {
    leavingRef.current = leaving
    const sheet = sheetRef.current
    if (!leaving || !sheet) return
    sheet.setAttribute('inert', '')
    sheet.setAttribute('aria-hidden', 'true')
  }, [leaving])

  // On the recede stack from mount to unmount: every sheet, whatever it holds (v2 draft §11.1).
  // Before the measure below, so the first frame the motion writes already reaches the page.
  // While this sheet is up the chrome behind the scrim is inert (`holdChromeInert`; one hold per
  // sheet, they nest) and so is the sheet beneath, from the stack. When it goes the chrome and
  // the lower sheet come back first, and then focus – still in this sheet, or dropped to nothing
  // by a scrim tap or the inert beneath – returns to the control that opened it (§9.22, §9.24),
  // which for a stacked sheet is a row of the sheet beneath; a sheet leaving from under another
  // leaves focus to that one, and hands it its own opener where the one above had found its
  // focus in this sheet's rows, or nothing (`openers`).
  useLayoutEffect(() => {
    const sheet = sheetRef.current
    const layer = layerRef.current
    const focused = document.activeElement
    const opener = {
      current: focused instanceof HTMLElement && focused !== document.body ? focused : null
    }
    if (layer) openers.set(layer, opener)
    const releaseChrome = holdChromeInert()
    const handle = registerRecedeLayer((frame) => {
      layerFrame.current = frame
      paint()
    })
    recede.current = handle
    return () => {
      const above = !handle.onTop()
      recede.current = null
      handle.release()
      releaseChrome()
      if (layer) {
        let upper = false
        for (const [el, o] of openers) {
          if (el === layer) upper = true
          else if (upper && (o.current === null || layer.contains(o.current)))
            o.current = opener.current
        }
        openers.delete(layer)
      }
      // The layout reporter measures the content frame on resize; a measurement taken while the
      // frame stood receded is 3 % small, so have it look again now that the frame is back.
      if (resizedWhileUp.current) window.dispatchEvent(new Event('resize'))
      const active = document.activeElement
      if (!above && (!active || active === document.body || sheet?.contains(active)))
        opener.current?.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once per mount
  }, [])

  // Focus moves into the sheet as it opens (§9.22) – on mount, while the sheet may still be held
  // at opacity 0 for the page's cover (an element at opacity 0 takes the focus; a hidden one
  // would not) – and again when its content is swapped from under it (a menu stepping into a
  // submenu) and the focus fell to nothing with the old rows. Focus a surface put elsewhere in
  // the sheet stays. A sheet with a sheet above it does not take the focus back: the top one
  // holds it (§9.24).
  useEffect(() => {
    const sheet = sheetRef.current
    const body = scrollRef.current
    if (!sheet || !body || !onTop()) return
    const active = document.activeElement
    if (active && active !== document.body && sheet.contains(active)) return
    sheetInitialFocus(sheet, body).focus({ preventScroll: true })
  }, [contentKey])

  // Tab wraps inside the sheet on top (§9.22): the chrome is inert, but past the last control the
  // WebView would otherwise hand the focus to the next native view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const sheet = sheetRef.current
      if (sheet && onTop()) wrapTab(sheet, e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    insetTop.current = insets.top
    const bottomChanged = insetBottom.current !== insets.bottom
    insetBottom.current = insets.bottom
    // New content starts at its top; the old scroll offset belonged to what was there before.
    if (!bottomChanged && scrollRef.current) scrollRef.current.scrollTop = 0
    measure()
    // The keyboard came up under a field that has the focus: the sheet makes room for it.
    if (bottomChanged) keepFieldInView()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the content or the insets change
  }, [contentKey, insets.top, insets.bottom])

  // A field taking focus while the keyboard is already up (the next field of a form) is kept in
  // view the same way.
  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    const onFocusIn = (): void => keepFieldInView()
    sheet.addEventListener('focusin', onFocusIn)
    return () => sheet.removeEventListener('focusin', onFocusIn)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest refs
  }, [])

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

  // `fitContent`: the grip (with the header) and the body's content are measured again when
  // they change size, so a sheet whose content arrives or grows after it is up follows it.
  useEffect(() => {
    const grip = gripRef.current
    const content = contentRef.current
    if (!fitContent || !grip || !content || typeof ResizeObserver !== 'function') return
    const heightOf = (): number => grip.offsetHeight + content.offsetHeight
    let last = heightOf()
    const observer = new ResizeObserver(() => {
      const height = heightOf()
      if (height === last) return
      last = height
      measure()
    })
    observer.observe(grip)
    observer.observe(content)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the observer reads the latest refs
  }, [fitContent])

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

  // Unmounted – once the sheet has landed under a `SheetPresence`, or mid-motion where its
  // request unmounts it directly: stop the spring without reporting a close, and let the page
  // back from under the cover. A cover still pending is dropped by clearing the ref (its `then`
  // checks it); `presented` is left alone so that StrictMode's rehearsal of this cleanup does
  // not stop the real mount from presenting.
  useEffect(
    () => () => {
      cover.current?.release()
      cover.current = null
      if (fade.current !== null) window.clearTimeout(fade.current)
      fade.current = null
      const m = motionRef.current
      if (!m) return
      afterDismiss.current = null
      latest.current = { onDismissed: () => undefined, onLeft: undefined }
      m.close()
    },
    []
  )

  /**
   * Dismissed while still waiting for the page to be covered: nothing is on screen to slide
   * away, so the sheet is simply gone (and the cover it took is let go of at once). True when
   * that was the case.
   */
  const dropCover = (then?: () => void): boolean => {
    if (presented.current) return false
    presented.current = true
    cover.current?.release()
    cover.current = null
    if (then) afterDismiss.current = then
    landed()
    return true
  }

  /** A finger caught the sheet during a reduced-motion departure: the fade is off, the sheet back. */
  const dropFade = (): void => {
    if (fade.current === null) return
    window.clearTimeout(fade.current)
    fade.current = null
    if (sheetRef.current) sheetRef.current.style.opacity = '1'
    paint()
  }

  const dismiss = (then?: () => void): void => {
    if (dropCover(then)) return
    const m = motion()
    if (!m.isOpen) return
    if (then) afterDismiss.current = then
    if (fade.current !== null) return
    if (reducedMotion() && sheetRef.current && scrimRef.current) {
      sheetRef.current.style.opacity = '0'
      scrimRef.current.style.opacity = '0'
      fade.current = window.setTimeout(() => {
        fade.current = null
        motion().dismiss()
      }, REDUCED_MOTION_FADE_MS)
      return
    }
    m.dismiss()
  }

  // The request went while the sheet stands (§11.1: a leave, never a vanish): the sheet runs its
  // own dismissal from wherever it is and answers `onLeft` when it has landed. A sheet that has
  // landed already – or never came up – answers at once. A finger holding the sheet keeps it:
  // the leave resumes when it lets go (`finish`).
  useEffect(() => {
    if (!leaving) return
    paint()
    if (touch.current) return
    const m = motionRef.current
    if (!presented.current) dropCover()
    else if (!m?.isOpen) landed()
    else dismiss()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest refs
  }, [leaving])

  // The back gesture over a leaving sheet is absorbed: the sheet is on its way already, and a
  // cancel must not bring back what has no request behind it.
  useImperativeHandle(
    ref,
    () => ({
      dismiss,
      backProgress: (progress) => {
        if (!touch.current && !leavingRef.current) motion().backProgress(progress)
      },
      commitBack: () => {
        if (leavingRef.current) return
        if (!dropCover()) motion().backCommit()
      },
      cancelBack: () => {
        if (!leavingRef.current) motion().backCancel()
      }
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
    dropFade()
    motion().beginDrag()
    // Captured only now: a capture from pointerdown on would retarget the click of a plain tap
    // away from the row that was tapped.
    capturePointer(e.currentTarget, e.pointerId)
    sheetRef.current?.setAttribute('data-dragging', 'true')
    syncLock()
  }

  /**
   * Whether the event happened in this layer's own DOM. React bubbles events through portals
   * along its own tree: a sheet stacked above this one through `FrameDialogPortal` from a
   * control in this sheet's body (an editor's menulist opening its list of options) has this
   * layer for a React ancestor, so its presses arrive here too – with a target outside
   * `sheetRef`, which read as a press on this sheet's scrim: the dismissal of this sheet under
   * the one above, and the row's click swallowed with it. A press that did not happen in this
   * layer is the upper sheet's; it goes unanswered here. Moves and releases need no such guard:
   * they answer only a pointer this layer's own press began tracking (`touch`), and one released
   * over a sheet that opened under the finger must still be let go of here.
   */
  const inLayer = (e: SyntheticEvent): boolean =>
    layerRef.current?.contains(e.target as Node) ?? false

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || touch.current || !inLayer(e)) return
    const target = e.target as HTMLElement
    const zone: Zone = !sheetRef.current?.contains(target)
      ? 'scrim'
      : target.closest('[data-sheet-grip]')
        ? 'grip'
        : 'body'
    // A drag produces no click to swallow; a new touch must start with a clean slate.
    swallowClick.current = false
    const moving = motion().current.phase === 'settling'
    // A press on a resting sheet's scrim is the dismissal itself (v2 draft §9.20, consumed on
    // `pointerdown`): the click that follows it reaches nothing. A press on the scrim while the
    // sheet moves catches the sheet instead.
    if (!moving && zone === 'scrim') {
      e.preventDefault()
      swallowClick.current = true
      dismiss()
      return
    }
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
      // A tap that landed on a leaving sheet's scrim held nothing: the leave goes on.
      if (leavingRef.current) dismiss()
      return
    }
    swallowClick.current = true
    const { vy } = cancelled ? { vy: 0 } : t.tracker.velocity(e.timeStamp)
    // A leaving sheet has no detent to return to: the finger's release sends it the rest of the
    // way with its velocity, a fling upwards included (the spring turns it round).
    if (leavingRef.current) motion().dismiss(vy)
    else motion().release(vy)
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
      className={hosted ? 'absolute inset-0' : 'fixed inset-0 z-[90]'}
      data-surface="page"
      data-sheet-layer="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onClickCapture={(e) => {
        if (!swallowClick.current || !inLayer(e)) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div ref={scrimRef} className="zen-sheet-scrim absolute inset-0" style={{ opacity: 0 }} />
      {/* Focusable itself (tabIndex -1), so a sheet whose first control must not take the focus
          on open – a form's text field on a phone – can still move the focus into the dialog.
          Held at opacity 0 and out of the pointer's way until `present` (the wait for the page's
          cover; `visibility: hidden` would refuse the focus that moves in on mount). */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        className={cn(
          'zen-sheet zen-sheet-detents absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-[520px] flex-col',
          className
        )}
        style={{ paddingBottom: Math.max(8, insets.bottom), opacity: 0, pointerEvents: 'none' }}
        data-locked="true"
        data-surface="page"
      >
        <div ref={gripRef} data-sheet-grip className="zen-sheet-grip shrink-0">
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
        <div ref={bodyRef} className="zen-sheet-scroll min-h-0 flex-1 overflow-y-auto">
          {fitContent ? <div ref={contentRef}>{children}</div> : children}
        </div>
        {footer && <div className="zen-sheet-footer shrink-0">{footer}</div>}
      </div>
    </div>
  )
}
