import type { JSX } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { AutofillPicker, PopupSurfaceRoom, PopupSurfaceSize } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { POPOVER_MARGIN } from '@renderer/lib/portals'
import {
  awaitTooltipRoom,
  measureTooltipSize,
  TOOLTIP_GAP,
  tooltipStore,
  tooltipTargetOf,
  tooltipText
} from '@renderer/lib/tooltip'
import { PickerPanel } from './PickerPanel'
import { useEscape } from './controls'

/** The panel's hairline border above and below its content. */
const PANEL_BORDERS = 2

/**
 * The autofill picker as the popup surface draws it (`PopupSurface`: the document the desktop
 * host floats over the page under the focused field, `ElectronWindow.setPopupSurface`): the
 * popover panel of `UIState.autofill.picker` on a transparent page, inside the 8 px margin the
 * core leaves for the panel's shadow. It tells the core the height its content wants
 * (`autofill.surfaceSize`) and when it holds the keyboard (`autofill.surfaceFocus`); the core
 * sizes and places the surface, and keeps the picker open while the surface has the focus.
 *
 * The panel's controls that carry a tooltip (§9.31's `data-tooltip`, read by the `Tooltip` host
 * `PopupSurface` mounts in this document: the lock on a row whose fill asks for the passphrase,
 * an `IconBtn`) stand near the panel's edge, and a tooltip `TOOLTIP_GAP` under one would be cut
 * by the surface's bounds, which hug the panel's box at rest. So the height report carries the
 * room the tooltip needs beyond the box (`PopupSurfaceRoom`, `tooltipRoom` – the folded pill's
 * handshake, `MiniMenu`), and the core grows the surface under and beside the panel without
 * moving it (`placePickerSurface`). The room is the armed control's own – none when its
 * tooltip stands inside the box as it is (a control well inside the panel) – asked the instant
 * a tooltip arms (the mouse pointer's arrival on the control: the `pointerover` the host's
 * dwell starts from, so the surface has grown, transparent, under the still pointer by the
 * time the tooltip paints; or a tooltip coming up on a control any other way – the store:
 * keyboard focus shows at once) and given back (`room: null`) the instant the moment is over:
 * the pointer leaving the panel, a press (the chassis takes the tooltip down on it), the
 * tooltip going with no pointer on the panel. The pointer browsing the panel's rows between
 * its controls keeps the room: the chassis shows the next tooltip at once within its browse
 * window, and a surface shrinking and growing again per row would flicker under it. The
 * tooltip's show is held until the room has landed – the core's word back (`PopupSurfaceSize`)
 * and this document's frame at the size (`awaitTooltipRoom`; §11's paint handshake) – or the
 * ceiling for a word that never comes.
 *
 * The panel keeps its box through the room: its width and its greatest height are pinned to
 * the surface's inner size at rest as the core last said it – the word back to a report with
 * no room – rather than to the document's (`.zen-v2-af-surface > .zen-v2-af-popover`'s
 * `100%`, the same size until the first word), so a list clamped to the window's share does
 * not grow into the room made under it; the pin follows the content's height as the core's
 * word does, and a widened surface centres the panel (`margin-inline: auto`).
 */
export function PickerSurface({ picker }: { picker: AutofillPicker }): JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const reported = useRef<{ height: number; room: PopupSurfaceRoom | null } | null>(null)
  // The control the mouse pointer armed a tooltip on (§9.31: only a mouse pointer arms one),
  // kept while the pointer browses the panel; null once it has left the panel or pressed.
  const armed = useRef<HTMLElement | null>(null)
  // Tells the core the height last measured again, with the room as it is now (or nothing
  // while the same report stands); the room's listeners call it.
  const tell = useRef<() => void>(() => undefined)
  // The hold on the tooltip's show while a room asked is on its way (`awaitTooltipRoom`'s
  // release); null while none is asked.
  const roomWait = useRef<(() => void) | null>(null)

  const release = useCallback((): void => {
    roomWait.current?.()
    roomWait.current = null
  }, [])

  // The control a tooltip is armed on or up for, inside the panel: the pointer's, or the one
  // the store shows (keyboard focus). A control gone from the panel (the list swapped for the
  // unlock step under a still pointer) is no one's.
  const wantedControl = useCallback((): HTMLElement | null => {
    const popover = popoverRef.current
    if (!popover) return null
    if (armed.current && !popover.contains(armed.current)) armed.current = null
    if (armed.current) return armed.current
    const up = tooltipStore.get().target
    return up !== null && popover.contains(up) ? up : null
  }, [])

  // The report: the content's height as last measured (or `height`, a new measurement), with
  // the room the armed control's tooltip needs right now, or null. Nothing goes out while the
  // same report stands. A report with a room holds the tooltip's show until the core's word
  // and this document's frame at the size it says; one without lets any hold go, and pins the
  // panel to the size at rest the word says.
  const report = useCallback(
    (height: number | null): void => {
      const last = reported.current
      const wanted = height ?? last?.height ?? 0
      if (wanted <= 0) return
      // The content's ref is attached before the panel's (a child's first): the first
      // measurement goes out with no room, as it should – nothing is armed yet.
      const popover = popoverRef.current
      const control = popover ? wantedControl() : null
      const room = popover && control ? tooltipRoom(popover, control) : null
      if (last && last.height === wanted && sameRoom(last.room, room)) return
      reported.current = { height: wanted, room }
      const answer = cmd('autofill.surfaceSize', { id: picker.id, height: wanted, room })
      if (room) {
        roomWait.current = awaitTooltipRoom(answer)
        return
      }
      release()
      void answer.then(
        (size) => {
          const el = popoverRef.current
          if (el) pinPanel(el, size)
        },
        () => undefined
      )
    },
    [picker.id, release, wantedControl]
  )

  useEffect(() => {
    tell.current = () => report(null)
    return () => {
      tell.current = () => undefined
      release()
    }
  }, [report, release])

  // The content box swaps between the list and the unlock step; each one is measured as it comes.
  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!el) return
      const measure = (): void => {
        const height = Math.ceil(el.getBoundingClientRect().height) + PANEL_BORDERS
        if (height > PANEL_BORDERS) report(height)
      }
      measure()
      if (typeof ResizeObserver !== 'undefined') {
        observer.current = new ResizeObserver(measure)
        observer.current.observe(el)
      }
    },
    [report]
  )
  useEffect(() => () => observer.current?.disconnect(), [])

  // The tooltip's moment: the room is told as it comes and goes (see the component's note).
  // The panel's own listeners, not the host's: the host knows nothing of the surface. Only a
  // mouse pointer arms a tooltip (§9.31; the host's test).
  useEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const mouse = (e: PointerEvent): boolean => e.pointerType === 'mouse' || e.pointerType === ''
    const onOver = (e: PointerEvent): void => {
      if (!mouse(e)) return
      const target = tooltipTargetOf(e.target)
      if (!target || target === armed.current) return
      armed.current = target
      tell.current()
    }
    const onOut = (e: PointerEvent): void => {
      if (!armed.current || !mouse(e)) return
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
      armed.current = null
      tell.current()
    }
    const onDown = (): void => {
      if (!armed.current) return
      armed.current = null
      tell.current()
    }
    el.addEventListener('pointerover', onOver)
    el.addEventListener('pointerout', onOut)
    el.addEventListener('pointerdown', onDown)
    const unsubscribe = tooltipStore.subscribe(() => tell.current())
    return () => {
      el.removeEventListener('pointerover', onOver)
      el.removeEventListener('pointerout', onOut)
      el.removeEventListener('pointerdown', onDown)
      unsubscribe()
      if (!armed.current) return
      armed.current = null
      tell.current()
    }
  }, [])

  // The document takes the keyboard on a press in it and lets go when the page (or another
  // window) takes it back.
  useEffect(() => {
    const focused = (value: boolean) => (): void =>
      run('autofill.surfaceFocus', { id: picker.id, focused: value })
    const onFocus = focused(true)
    const onBlur = focused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    if (document.hasFocus()) onFocus()
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [picker.id])

  useEscape(() => run('autofill.pick', { id: picker.id, itemId: null }))

  return (
    <div className="zen-v2-af-surface" data-surface="page">
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={picker.manageLabel.replace(/^Manage /, 'Saved ')}
        className="zen-v2-af zen-v2-af-popover"
      >
        <PickerPanel picker={picker} contentRef={contentRef} />
      </div>
    </div>
  )
}

/**
 * The room the surface needs beyond the panel's padded box for `control`'s tooltip
 * (`PopupSurfaceRoom`): `below`, so a tooltip the host places `TOOLTIP_GAP` under the control
 * ends `POPOVER_MARGIN` inside the document, and `width`, the tooltip's box for the text
 * (`measureTooltipSize`: the chassis's own box for it) with the margin each side. The control
 * stands where its client rect says – where the host will place the tooltip (a row scrolled
 * in the list stands where it shows; the panel plays no pop) – against the box read off the
 * layout: the panel at the surface's padding (its offset in the document, the same under it
 * as over it). Null when the tooltip stands inside the box as it is – a control well inside
 * the panel – and when nothing is laid out (a DOM without layout), so a report carries no
 * room rather than a wrong one.
 */
function tooltipRoom(popover: HTMLElement, control: HTMLElement): PopupSurfaceRoom | null {
  const text = tooltipText(control)
  if (!text) return null
  const tip = measureTooltipSize([text])
  if (tip.width <= 0 || tip.height <= 0) return null
  const pad = popover.offsetTop
  const box = { width: pad + popover.offsetWidth + pad, height: pad + popover.offsetHeight + pad }
  const need = control.getBoundingClientRect().bottom + TOOLTIP_GAP + tip.height + POPOVER_MARGIN
  const below = Math.max(0, Math.ceil(need - box.height))
  const width = Math.ceil(tip.width) + 2 * POPOVER_MARGIN
  if (below === 0 && width <= box.width) return null
  return { below, width }
}

/**
 * Pin the panel's box to the surface's inner size at rest, as the core's word to a report with
 * no room says it (`PopupSurfaceSize`, less the surface's padding each side): its width, and
 * the most it may grow to – what the stylesheet's `100%` gives at rest, held through the room.
 * A null word (no surface placed) leaves the stylesheet's.
 */
function pinPanel(popover: HTMLElement, size: PopupSurfaceSize | null): void {
  if (!size) {
    popover.style.width = ''
    popover.style.maxHeight = ''
    return
  }
  const pad = popover.offsetTop
  popover.style.width = `${Math.max(0, size.width - 2 * pad)}px`
  popover.style.maxHeight = `${Math.max(0, size.height - 2 * pad)}px`
}

function sameRoom(a: PopupSurfaceRoom | null, b: PopupSurfaceRoom | null): boolean {
  if (!a || !b) return a === b
  return a.below === b.below && a.width === b.width
}
