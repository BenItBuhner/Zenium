import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { subscribePopovers } from '@renderer/lib/popoverStore'
import { ChromePortal, toRect, viewportSize } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import {
  placeTooltip,
  TOOLTIP_ATTR,
  TOOLTIP_ID,
  tooltip,
  tooltipCoverHeld,
  tooltipPaneOf,
  tooltipStore,
  tooltipTargetOf,
  tooltipText,
  type TooltipPlacement
} from '@renderer/lib/tooltip'
import {
  browserStore,
  contentAreaStore,
  holdFloatingChrome,
  pageHidden,
  uiStore
} from '@renderer/lib/ui'

/**
 * The chrome tooltip's host (lib/tooltip.ts; design-language-v2-draft §9.31, a11y-26): one
 * for the window, mounted by the desktop shell, listening on the document for the pointer and
 * the keyboard reaching any control that carries `data-tooltip`. It draws the one tooltip in
 * the chrome layer – 13/400 on `--v2-panel` with the hairline, radius 6, no arrow, 8 px from
 * the control and never over it, slid and flipped to stay inside the control's pane and the
 * window (`placeTooltip`) – marks the control `aria-describedby` it while it is up, and takes
 * it down on the pointer leaving, focus leaving, a press, Escape, the window losing focus, a
 * scroll or resize, the control leaving the DOM or losing its text, and other chrome opening.
 *
 * The tab views draw above the chrome's DOM: a tooltip that has to lie over the page (a toolbar
 * band with the page right under it; §9.29's layouts) waits for the page to go under its
 * picture first (`holdFloatingChrome`, the hover card's and the popovers' way), and keeps that
 * one hold while the pointer browses from control to control, so the page does not flash back
 * between two tooltips. A tooltip that fits in its pane – every one in the sidebar – touches
 * the page not at all.
 */
export function Tooltip(): JSX.Element | null {
  const { target, by } = tooltipStore.use()
  // The text is the control's attribute, read at render; `words` re-renders when it changes.
  const [, setWords] = useState(0)
  const text = target ? tooltipText(target) : ''
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null)
  // Whether the page is under its picture right now – by the tooltip's own hold once the
  // capture is in place (`floatingChrome`), or by other chrome's – which is when a tooltip over
  // the page's box may show.
  const pageUnderCover = uiStore.use(pageHidden)
  const ref = useRef<HTMLDivElement>(null)
  const hold = useRef<Hold | null>(null)

  // The document's events, once, for every control now or later in the DOM. A touch or pen
  // pointer shows nothing (§9.31): the row's context menu header carries the full title there.
  useEffect(() => {
    const mouse = (e: PointerEvent): boolean => e.pointerType === 'mouse' || e.pointerType === ''
    const onOver = (e: PointerEvent): void => {
      if (!mouse(e)) return
      const next = tooltipTargetOf(e.target)
      const prev = tooltipTargetOf(e.relatedTarget)
      if (next === prev) return
      if (prev) tooltip.pointerLeave(prev)
      if (next) tooltip.pointerEnter(next)
    }
    const onOut = (e: PointerEvent): void => {
      if (!mouse(e)) return
      const prev = tooltipTargetOf(e.target)
      if (prev && prev !== tooltipTargetOf(e.relatedTarget)) tooltip.pointerLeave(prev)
    }
    // The control is the nearest element carrying the text, the keyboard's test is on the
    // element that took the focus: a control may be a box around its focusable part (the URL
    // pill – the group carries the address, its button inside takes the Tab stop).
    const onFocusIn = (e: FocusEvent): void => {
      const next = tooltipTargetOf(e.target)
      if (next && e.target instanceof HTMLElement && keyboardFocus(e.target)) tooltip.focus(next)
    }
    const onFocusOut = (e: FocusEvent): void => {
      const prev = tooltipTargetOf(e.target)
      if (prev) tooltip.blur(prev)
    }
    const onDown = (): void => {
      tooltip.dismiss()
    }
    // Escape is the tooltip's only while one is showing: consumed then (the control keeps the
    // keyboard, nothing under it hears the key), let by otherwise – the popups' stack and the
    // chrome's own Escape (Stop) are never touched for a key that was not the tooltip's.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !tooltip.showing()) return
      if (tooltip.dismiss()) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const hide = (): void => tooltip.hide()
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', hide, { capture: true, passive: true })
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    const unsubscribe = subscribePopovers((change) => {
      if (change === 'open' || change === 'all') tooltip.hide()
    })
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', hide, { capture: true })
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
      unsubscribe()
      tooltip.hide()
    }
  }, [])

  // While the tooltip is up: its text follows the control's attribute (Reload becoming Stop
  // under the pointer), the control leaving the DOM takes it down (the chrome's tree is watched
  // only for as long as a tooltip shows), and the control is `aria-describedby` it – put back
  // as it was after.
  useLayoutEffect(() => {
    if (!target) return
    const words = new MutationObserver(() => {
      if (tooltipText(target)) setWords((n) => n + 1)
      else tooltip.hide()
    })
    words.observe(target, { attributes: true, attributeFilter: [TOOLTIP_ATTR] })
    const gone = new MutationObserver(() => {
      if (!target.isConnected) tooltip.hide()
    })
    gone.observe(document.body, { childList: true, subtree: true })
    const before = target.getAttribute('aria-describedby')
    target.setAttribute('aria-describedby', before ? `${before} ${TOOLTIP_ID}` : TOOLTIP_ID)
    return () => {
      words.disconnect()
      gone.disconnect()
      const now = target.getAttribute('aria-describedby')
      if (now === null) return
      const rest = now
        .split(/\s+/)
        .filter((id) => id && id !== TOOLTIP_ID)
        .join(' ')
      if (rest) target.setAttribute('aria-describedby', rest)
      else target.removeAttribute('aria-describedby')
    }
  }, [target])

  // The tooltip's own size decides where it fits; measured once it has rendered its text.
  useLayoutEffect(() => {
    const el = ref.current
    if (!target || !el || !text) {
      setPlacement(null)
      return
    }
    const pane = tooltipPaneOf(target)
    setPlacement(
      placeTooltip(
        toRect(target.getBoundingClientRect()),
        { width: el.offsetWidth, height: el.offsetHeight },
        viewportSize(),
        pane ? toRect(pane.getBoundingClientRect()) : null,
        contentAreaStore.get().area
      )
    )
  }, [target, text])

  // Over the page, the page goes under its picture first – unless it is under one already (a
  // revealed compact sidebar, another overlay) – and the one hold stays across the controls the
  // pointer browses; it is let go when a tooltip fits beside the page again or none is up. A
  // tooltip the pointer put up while the page had the keyboard gives it back on release
  // (`pageHadFocus`); one on a focused control leaves the keyboard on the control (§9.22).
  const covers = placement?.coversPage ?? null
  useLayoutEffect(() => {
    if (!target) {
      releaseHold(hold)
      return
    }
    if (covers === null) return
    if (!covers) {
      releaseHold(hold)
      return
    }
    if (hold.current || pageHidden(uiStore.get())) return
    const state = browserStore.get().state
    const pageHadFocus =
      by === 'pointer' &&
      (document.activeElement === null || document.activeElement === document.body)
    const taken = holdFloatingChrome(state ? (activeTab(state)?.id ?? null) : null, {
      pageHadFocus
    })
    const entry: Hold = { release: taken.release }
    hold.current = entry
    void taken.ready.then((held) => {
      if (hold.current === entry && held) tooltipCoverHeld(true)
    })
  }, [target, covers, by])
  useEffect(() => () => releaseHold(hold), [])

  if (!target || !text) return null
  const shown = placement !== null && (!placement.coversPage || pageUnderCover)
  return (
    <ChromePortal>
      <div
        ref={ref}
        id={TOOLTIP_ID}
        role="tooltip"
        className="zen-tooltip zen-animate-pop"
        // A plain panel (§9.31): a page surface in either layout, as the popovers beside it in
        // the chrome layer declare on their own roots (§9.29's two families).
        data-surface="page"
        data-side={placement?.box.side}
        data-by={by ?? undefined}
        style={{
          left: placement?.box.left ?? 0,
          top: placement?.box.top ?? 0,
          visibility: shown ? 'visible' : 'hidden'
        }}
      >
        {text}
      </div>
    </ChromePortal>
  )
}

interface Hold {
  release: () => void
}

function releaseHold(hold: { current: Hold | null }): void {
  const entry = hold.current
  if (!entry) return
  hold.current = null
  tooltipCoverHeld(false)
  entry.release()
}

/**
 * Whether the focus that landed on `focused` came from the keyboard – `:focus-visible` (a
 * pointer's press focuses a button without it, and its tooltip is the pointer's to show after
 * the wait). A DOM without the pseudo-class (a test's) counts every focus as the keyboard's.
 */
function keyboardFocus(focused: HTMLElement): boolean {
  try {
    return focused.matches(':focus-visible')
  } catch {
    return true
  }
}
