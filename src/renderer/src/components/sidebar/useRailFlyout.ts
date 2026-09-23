import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { onEvent } from '@renderer/lib/api'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { captureActiveTab, invalidateSnapshot, uiStore } from '@renderer/lib/ui'

/**
 * How long the pointer rests on the rail before it flies out (tabs-03): Edge's vertical tabs
 * expand about 300 ms after the pointer lands on the collapsed strip, long enough that a pointer
 * crossing the rail on its way to the page opens nothing.
 */
export const RAIL_FLYOUT_DWELL_MS = 300

/**
 * How long the flyout stays out after the pointer (and the keyboard) has left it before it folds
 * back: Edge's strip collapses 400–500 ms after the pointer leaves, so a pointer that slips off
 * the rows and back finds the flyout where it was.
 */
export const RAIL_FLYOUT_GRACE_MS = 450

/**
 * The most an open waits for the host to take the live page down before the width sets off
 * regardless. The page view composites above the chrome: a frame of the flyout drawn under it
 * would be cut at the rail's edge, so the spring waits for the core's `layout.applied` that
 * hid the view – two or three frames after the capture stands in for the page – and no longer
 * than this (a window with no page has no view to hide, and nothing answers).
 */
export const RAIL_FLYOUT_COVER_WAIT_MS = 160

export interface RailFlyoutOptions {
  /** The Collapsed sidebar layout with `sidebarExpandOnHover` on, a fine pointer, docked. */
  enabled: boolean
  /** The rail's width at rest (px). */
  rest: number
  /** The flyout's width at its full extent: the expanded sidebar's (px). */
  extent: number
  /** The active tab, whose picture stands in for the live page while the flyout is out. */
  activeTabId: string | null
}

/**
 * The collapsed rail's flyout (tabs-03; v2 §9.37, §11.4): after a short dwell of the pointer on
 * the rail (`RAIL_FLYOUT_DWELL_MS`) the sidebar flies out to its expanded width OVER the page –
 * the frame stays where it is – on `SPRING_GENTLE`, the container motion the sidebar's fold runs
 * on, and folds back once the pointer and the keyboard have both left it for a grace
 * (`RAIL_FLYOUT_GRACE_MS`), at once on Escape or a press into the page. The keyboard landing in
 * the rail (the pane chord, Tab – a `:focus-visible` focus, not a click's) flies it out with no
 * dwell and holds it while the focus stays inside.
 *
 * The page under it is its picture: the page view composites above the chrome, so the flyout
 * takes the active tab's capture and raises `railFlyout` – the layout reporter hides the view
 * (`pageHidden`) and the frame shows the picture (`ContentArea`) – as the compact sidebar's
 * reveal does, and the width sets off once the core has taken the view down (`layout.applied`).
 * A tab activated from the flyout's rows takes its own picture in the frame. At the fold's rest
 * the flag drops and the live page comes back (`invalidateSnapshot`). Under reduced motion the
 * width is a cut (§11.3): the spring jumps to its end on `start`.
 *
 * Returns whether the rows draw in their expanded form (titles, the New Tab row): from the
 * moment the width sets off until the fold rests, so a title clips as the width shrinks rather
 * than vanishing while the flyout is still wide. The width itself is written on `box` per frame
 * beside `data-flyout` (`opening` | `out` | `folding`; absent at rest), never through React.
 */
export function useRailFlyout(
  aside: RefObject<HTMLElement | null>,
  box: RefObject<HTMLDivElement | null>,
  { enabled, rest, extent, activeTabId }: RailFlyoutOptions
): boolean {
  const [out, setOut] = useState(false)
  const flyout = useRef<RailFlyout | null>(null)
  useLayoutEffect(() => {
    const f = new RailFlyout(box, setOut)
    flyout.current = f
    return () => {
      f.dispose()
      flyout.current = null
    }
  }, [box])

  useEffect(() => {
    flyout.current?.configure(rest, extent)
  }, [rest, extent])

  useEffect(() => {
    flyout.current?.setActiveTab(activeTabId)
  }, [activeTabId])

  useEffect(() => {
    const el = aside.current
    const f = flyout.current
    if (!enabled || !el || !f) {
      f?.disable()
      return
    }
    const enter = (): void => f.pointerEnter()
    const leave = (): void => f.pointerLeave()
    const focusIn = (e: FocusEvent): void => {
      if (e.target instanceof HTMLElement && keyboardFocused(e.target)) f.keyboardIn()
    }
    const focusOut = (e: FocusEvent): void => {
      const to = e.relatedTarget
      if (!(to instanceof Node) || !el.contains(to)) f.keyboardOut()
    }
    // A press anywhere outside the flyout – the page's picture, the toolbar, the frame – folds it
    // at once (§9.20's light dismiss, without consuming the press: the click is the page's, and
    // the page is back the moment the fold rests).
    const pressOutside = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !el.contains(e.target)) f.dismiss()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) f.dismiss()
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('focusin', focusIn)
    el.addEventListener('focusout', focusOut)
    window.addEventListener('pointerdown', pressOutside, true)
    window.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('focusin', focusIn)
      el.removeEventListener('focusout', focusOut)
      window.removeEventListener('pointerdown', pressOutside, true)
      window.removeEventListener('keydown', key)
      f.disable()
    }
  }, [aside, enabled])

  return out
}

/**
 * A focus the keyboard gave (`:focus-visible`: Tab, the arrows, the pane chord), not a click's –
 * a press on a row focuses it too, and a press is the pointer's, whose dwell and grace rule.
 */
function keyboardFocused(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

type Phase = 'rest' | 'opening' | 'out' | 'folding'

/**
 * The flyout's machine: the dwell and the grace, the capture that stands in for the page, the
 * width on its spring. `pointerEnter` / `pointerLeave` / `keyboardIn` / `keyboardOut` say where
 * the pointer and the keyboard are; the flyout is wanted while either is inside, and heads for
 * the rail after the grace once neither is. `dismiss` folds it at once.
 */
export class RailFlyout {
  private phase: Phase = 'rest'
  private pointerInside = false
  private keyboardInside = false
  private dwell: ReturnType<typeof setTimeout> | null = null
  private grace: ReturnType<typeof setTimeout> | null = null
  /** The open in flight: cleared when the flyout is no longer wanted before the width sets off. */
  private opening: { cancel(): void } | null = null
  private rest = 56
  private extent = 240
  private activeTabId: string | null = null
  private readonly spring: SpringAnimation

  constructor(
    private readonly box: RefObject<HTMLDivElement | null>,
    private readonly setOut: (out: boolean) => void
  ) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (width) => {
        // The spring's hair of overshoot past either end (§7) is drawn nothing: the rail's
        // width is the floor and the extent the ceiling.
        const el = this.box.current
        if (el) el.style.width = `${Math.min(this.extent, Math.max(this.rest, width))}px`
      },
      () => this.rested()
    )
  }

  /** The rail's width and the flyout's; a change while out retargets the spring. */
  configure(rest: number, extent: number): void {
    this.rest = rest
    this.extent = extent
    if (this.phase === 'out') this.spring.retarget(extent)
  }

  /**
   * The active tab changed: out over the page, the flyout takes the new tab's picture – a fresh
   * one, its view being hidden under the flyout already (`captureActiveTab`'s `fresh`).
   */
  setActiveTab(tabId: string | null): void {
    if (this.activeTabId === tabId) return
    this.activeTabId = tabId
    if (this.phase === 'out' || this.phase === 'opening') {
      void captureActiveTab(tabId, { fresh: true })
    }
  }

  get current(): Phase {
    return this.phase
  }

  pointerEnter(): void {
    this.pointerInside = true
    this.clearGrace()
    if (this.phase === 'folding') {
      // Caught on its way back: out again from where it is.
      this.phase = 'out'
      this.mark('out')
      this.moving(true)
      this.spring.retarget(this.extent)
      return
    }
    if (this.phase !== 'rest' || this.dwell !== null) return
    this.dwell = setTimeout(() => {
      this.dwell = null
      // A tab in the hand: the rows are drop targets, and the flyout would move them under it.
      if (uiStore.get().drag) return
      this.open()
    }, RAIL_FLYOUT_DWELL_MS)
  }

  pointerLeave(): void {
    this.pointerInside = false
    this.clearDwell()
    this.armGrace()
  }

  keyboardIn(): void {
    this.keyboardInside = true
    this.clearGrace()
    if (this.phase === 'folding') {
      this.phase = 'out'
      this.mark('out')
      this.moving(true)
      this.spring.retarget(this.extent)
      return
    }
    if (this.phase === 'rest') {
      this.clearDwell()
      this.open()
    }
  }

  keyboardOut(): void {
    this.keyboardInside = false
    this.armGrace()
  }

  /** Escape, or a press outside: fold at once, whatever holds it. */
  dismiss(): void {
    if (this.phase === 'rest') return
    this.clearGrace()
    this.fold()
  }

  /** The flyout is no longer offered (the setting off, the layout changed, a touch screen). */
  disable(): void {
    this.clearDwell()
    this.clearGrace()
    this.pointerInside = false
    this.keyboardInside = false
    if (this.phase !== 'rest') this.fold()
  }

  dispose(): void {
    this.clearDwell()
    this.clearGrace()
    this.opening?.cancel()
    this.opening = null
    this.spring.stop()
    if (this.phase !== 'rest') {
      this.phase = 'rest'
      uiStore.set({ railFlyout: false })
      invalidateSnapshot()
    }
  }

  private armGrace(): void {
    if (this.pointerInside || this.keyboardInside) return
    if (this.phase === 'rest' || this.phase === 'folding') return
    this.clearGrace()
    this.grace = setTimeout(() => {
      this.grace = null
      this.fold()
    }, RAIL_FLYOUT_GRACE_MS)
  }

  /** Take the page's picture, raise the flag, and set off once the host has taken the view down. */
  private open(): void {
    if (this.phase !== 'rest') return
    this.phase = 'opening'
    this.mark('opening')
    let live = true
    let unsubscribe: (() => void) | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    const stop = (): void => {
      unsubscribe?.()
      unsubscribe = null
      if (deadline !== null) clearTimeout(deadline)
      deadline = null
    }
    this.opening = {
      cancel: () => {
        live = false
        stop()
      }
    }
    void captureActiveTab(this.activeTabId).then(() => {
      if (!live) {
        // Wanted no more before the picture came: nothing was raised, so nothing holds it.
        invalidateSnapshot()
        return
      }
      uiStore.set({ railFlyout: true })
      const go = (): void => {
        if (!live) return
        stop()
        this.opening = null
        this.phase = 'out'
        this.mark('out')
        this.moving(true)
        this.setOut(true)
        this.spring.start(this.rest, 0, this.extent)
      }
      unsubscribe = onEvent('layout.applied', (applied) => {
        if (applied.contentHidden) go()
      })
      deadline = setTimeout(go, RAIL_FLYOUT_COVER_WAIT_MS)
    })
  }

  private fold(): void {
    if (this.phase === 'rest') return
    if (this.phase === 'opening') {
      // Not out yet: let the open go. The flag raised already – the view on its way down – the
      // rest at the rail's width brings the page back at once, nothing having moved.
      this.opening?.cancel()
      this.opening = null
      this.phase = 'folding'
      this.rested()
      return
    }
    // Under reduced motion the spring never runs: `retarget` starts it, and the start is the
    // cut to the rail (§11.3).
    this.phase = 'folding'
    this.mark('folding')
    this.moving(true)
    this.spring.retarget(this.rest)
  }

  /** The spring rested: at the rail (a fold, the flag drops) or at the flyout's extent. */
  private rested(): void {
    const el = this.box.current
    this.moving(false)
    if (this.phase === 'folding') {
      this.phase = 'rest'
      this.mark(null)
      if (el) el.style.width = ''
      this.setOut(false)
      if (uiStore.get().railFlyout) uiStore.set({ railFlyout: false })
      invalidateSnapshot()
      // The pointer still on the rail after a dismiss arms no dwell: it has to leave and come
      // back. The keyboard inside holds nothing either until it moves again.
      return
    }
    if (this.phase === 'out' && el) el.style.width = `${this.extent}px`
  }

  private mark(state: 'opening' | 'out' | 'folding' | null): void {
    const el = this.box.current
    if (!el) return
    if (state === null) delete el.dataset.flyout
    else el.dataset.flyout = state
  }

  /** `data-flyout-moving`: on while the width is on its way, off at every rest. */
  private moving(on: boolean): void {
    const el = this.box.current
    if (!el) return
    if (on) el.dataset.flyoutMoving = ''
    else delete el.dataset.flyoutMoving
  }

  private clearDwell(): void {
    if (this.dwell !== null) clearTimeout(this.dwell)
    this.dwell = null
  }

  private clearGrace(): void {
    if (this.grace !== null) clearTimeout(this.grace)
    this.grace = null
  }
}
