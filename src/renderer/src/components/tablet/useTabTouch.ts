import {
  useEffect,
  useLayoutEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { liftTabByTouch, type TouchTabDrag } from '@renderer/lib/drag'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { clearTabSelection } from '@renderer/lib/ui'

/** Hold before a row comes off the list: the phone's card lift's (`useCardLift`). */
export const TAB_LONG_PRESS_MS = 380
/** Movement (px) that makes a hold a scroll, and a lifted row a drag. */
const SLOP = 8
/** How long a released hold waits for its click before opening the menu regardless. */
const MENU_DELAY_MS = 250

export interface TabTouch {
  /** True when the touch is the hook's: the row's own pointerdown handling stops there. */
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => boolean
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  /** True when the browser's context menu for the held finger was taken: the hold owns it. */
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => boolean
  /** True once per touch that was a long-press, so the click that follows it is not a tap. */
  swallowsClick: () => boolean
}

/**
 * A finger on a sidebar tab row of the tablet (TABLET-02). A tap is the row's click. A hold of
 * `TAB_LONG_PRESS_MS` lifts the row – a haptic tick, the row's ghost standing off the list under
 * the finger – into `lib/drag.ts`'s session by [liftTabByTouch]: released in place, the row goes
 * back down and the tab's menu sheet comes up (on the click that follows the release, so the
 * sheet's scrim cannot receive that same click, or after a moment if no click comes); moved,
 * it is the reorder – the neighbours slide open, the caret marks the slot, the row lands where
 * the finger lets go – with the page and the window's edge refused as targets (the tab never
 * tears off into another window from a finger). A touch that moves before the hold is up is
 * the list's scroll (or the sidebar's swipe) and is left to it.
 *
 * Off (`enabled` false) the hook takes nothing, and the row keeps the mouse's drag and the
 * browser's long-press context menu. On, the browser's own context menu for the held finger is
 * taken (`onContextMenu`): Chromium raises it during the hold, and letting it show would end
 * the touch under the lifted row. Once lifted, the touch is followed on the window: its events
 * keep coming whatever the row's element goes through.
 */
export function useTabTouch(tab: Tab, enabled: boolean): TabTouch {
  // One controller for the row's life, never replaced: the window's listeners are its own.
  const [touch] = useState(() => new TouchHold(tab, enabled))
  useLayoutEffect(() => {
    touch.sync(tab, enabled)
  })
  useEffect(() => () => touch.dispose(), [touch])
  return touch
}

interface Hold {
  id: number
  x: number
  y: number
  el: HTMLElement
  timer: ReturnType<typeof setTimeout> | null
}

interface Drag {
  id: number
  x0: number
  y0: number
  moved: boolean
  anchor: EventTarget
  handle: TouchTabDrag
}

/** The hook's state, one per row, outliving its renders (the window's listeners are its own). */
class TouchHold implements TabTouch {
  private hold: Hold | null = null
  private drag: Drag | null = null
  private swallow = false
  private pendingMenu: { timer: ReturnType<typeof setTimeout>; open: () => void } | null = null

  constructor(
    private tab: Tab,
    private enabled: boolean
  ) {}

  /** The row's props as they stand after a render. */
  sync(tab: Tab, enabled: boolean): void {
    this.tab = tab
    this.enabled = enabled
  }

  readonly onPointerDown = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (!this.enabled || e.pointerType === 'mouse' || e.button !== 0) return false
    // A second finger while one holds or drags: not a touch of its own, and not the row's.
    if (this.hold || this.drag) return true
    // The row's buttons (close, mute, wake) keep their taps.
    if ((e.target as HTMLElement).closest('button')) return false
    this.swallow = false
    const el = e.currentTarget
    const h: Hold = { id: e.pointerId, x: e.clientX, y: e.clientY, el, timer: null }
    h.timer = setTimeout(() => this.lift(h), TAB_LONG_PRESS_MS)
    this.hold = h
    // Every event of this touch comes here, wherever the finger wanders; a native scroll still
    // takes the touch over (with a pointercancel) when it moves before the hold is up.
    try {
      capturePointer(el, e.pointerId)
    } catch {
      /* the pointer is gone */
    }
    return true
  }

  readonly onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const h = this.hold
    if (!h || h.id !== e.pointerId) return
    // Off before the hold is up: a scroll of the list or a swipe of the sidebar, not ours.
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) >= SLOP) this.clearHold()
  }

  readonly onPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    if (this.hold?.id === e.pointerId) this.clearHold()
  }

  readonly onPointerCancel = (e: ReactPointerEvent<HTMLElement>): void => {
    if (this.hold?.id === e.pointerId) this.clearHold()
  }

  readonly onContextMenu = (e: ReactMouseEvent<HTMLElement>): boolean => {
    if (!this.enabled || (!this.hold && !this.drag)) return false
    e.preventDefault()
    return true
  }

  readonly swallowsClick = (): boolean => {
    const s = this.swallow
    this.swallow = false
    // The click landed: the menu comes up now rather than after the wait.
    this.firePendingMenu()
    return s
  }

  /** The row is going: whatever the finger was doing is over, without a menu. */
  dispose(): void {
    this.clearHold()
    this.clearPendingMenu()
    this.endDrag()?.handle.cancel()
  }

  private lift(h: Hold): void {
    h.timer = null
    this.hold = null
    const handle = liftTabByTouch(this.tab, h.el, h.x, h.y, performance.now())
    // Another drag has the rows: this hold is nothing, and its release a tap.
    if (!handle) return
    this.swallow = true
    vibrate(8)
    this.drag = { id: h.id, x0: h.x, y0: h.y, moved: false, anchor: h.el, handle }
    // From here the touch is the drag's, heard on the window. A touch that has picked a row up
    // must not scroll the list under it: touch-action is too late for that, so its touchmoves
    // are cancelled instead – on the document and on the node they started on (Chromium keeps
    // dispatching a touch's events to that node should React take it out of the document).
    window.addEventListener('pointermove', this.onWindowMove, true)
    window.addEventListener('pointerup', this.onWindowUp, true)
    window.addEventListener('pointercancel', this.onWindowCancel, true)
    document.addEventListener('touchmove', blockTouchScroll, { passive: false })
    h.el.addEventListener('touchmove', blockTouchScroll, { passive: false })
  }

  private readonly onWindowMove = (e: PointerEvent): void => {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < SLOP) return
    d.moved = true
    d.handle.move(e.clientX, e.clientY, e.timeStamp)
  }

  private readonly onWindowUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.drag?.id) return
    const d = this.endDrag()
    if (!d) return
    if (d.moved) {
      d.handle.release(e.clientX, e.clientY, e.timeStamp)
      return
    }
    // Held and let go where it was: the row goes back down, and the menu comes up.
    d.handle.cancel()
    const x = Math.round(e.clientX)
    const y = Math.round(e.clientY)
    this.scheduleMenu(() => {
      clearTabSelection()
      run('tab.contextMenu', { tabId: this.tab.id, x, y })
    })
  }

  private readonly onWindowCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.drag?.id) return
    this.endDrag()?.handle.cancel()
  }

  private endDrag(): Drag | null {
    const d = this.drag
    if (!d) return null
    this.drag = null
    window.removeEventListener('pointermove', this.onWindowMove, true)
    window.removeEventListener('pointerup', this.onWindowUp, true)
    window.removeEventListener('pointercancel', this.onWindowCancel, true)
    document.removeEventListener('touchmove', blockTouchScroll)
    d.anchor.removeEventListener('touchmove', blockTouchScroll)
    return d
  }

  private clearHold(): void {
    if (this.hold?.timer) clearTimeout(this.hold.timer)
    this.hold = null
  }

  private scheduleMenu(open: () => void): void {
    this.clearPendingMenu()
    this.pendingMenu = { timer: setTimeout(() => this.firePendingMenu(), MENU_DELAY_MS), open }
  }

  private firePendingMenu(): void {
    const menu = this.pendingMenu
    if (!menu) return
    clearTimeout(menu.timer)
    this.pendingMenu = null
    menu.open()
  }

  private clearPendingMenu(): void {
    if (this.pendingMenu) clearTimeout(this.pendingMenu.timer)
    this.pendingMenu = null
  }
}

function blockTouchScroll(e: Event): void {
  if (e.cancelable) e.preventDefault()
}

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* not available */
  }
}
