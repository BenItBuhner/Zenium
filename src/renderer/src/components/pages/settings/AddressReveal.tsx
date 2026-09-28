import type { JSX, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  addressBlur,
  addressFocus,
  addressHold,
  addressPointerEnter,
  addressPointerLeave,
  addressRevealStore,
  addressRowOf,
  elidedAddressOf,
  hideAddressCard,
  placeAddressCard,
  type AddressSubject
} from '@renderer/lib/addressReveal'
import { bindHoverCardDismissals } from '@renderer/lib/hoverCard'
import { KEYBOARD_FOCUS_ATTR } from '@renderer/lib/panes'
import {
  ChromePortal,
  insideFrameDialog,
  POPOVER_WIDTH,
  popoverStyle,
  subscribePopovers,
  viewportSize,
  type PopoverBox
} from '@renderer/lib/portals'
import { LONG_PRESS_MS, RELEASE_DELAY_MS, SLOP } from '../../phone/useLongPress'
import type { SheetRequest } from './rows'

/** The card's element id (one card at a time, as the tab card and the tooltip). */
export const ADDRESS_CARD_ID = 'zen-address-hover-card'

/** What a touch held on a shortened row asks the page's sheet stack for. */
export type AddressHoldRequest = Extract<SheetRequest, { kind: 'address' }>

/**
 * The Settings page's host for §9.2's reveal of a shortened path or address (services seed
 * #32; the lead's ruling on #685 item 4: "an elided address gets §9.31's reveal, the hover
 * card on a mouse and the hold-sheet header on touch"). One host per page layout
 * (`PhoneSettings`, `DesktopSettings`), listening on the document the way the chrome's tooltip
 * host does (components/Tooltip.tsx) – so every renderer that draws `Description` with
 * `address` has the reveal for free: the phone's rows, the desktop's two-pane rows, a picker
 * sheet's or dialog's options – and acting only for rows of its own page (its root's, or a frame
 * dialog's, which the frame draws outside the page's tree), so a Settings tab kept mounted in
 * the background answers for nothing.
 *
 * No hover-card primitive exists to reuse – the tab card (`TabHoverCard`) is the tab's, its
 * slice of the UI state and its page capture with it – so this is the tooltip host's pattern
 * around the tab card's machine (`HoverCardController`, lib/addressReveal.ts) and the tab
 * card's chrome (`.zen-tab-hover-card`, §9.20's panel at the 320 list width): a `role="tooltip"`
 * in the chrome layer carrying the whole value, hung under the row flush with its bottom edge
 * and start-aligned with it, flipped above near the window's bottom (`placeAddressCard`), after
 * Chrome's ~800 ms on a mouse, moving to a neighbouring shortened row without the wait, at once
 * under keyboard focus (§9.22, the `:focus-visible` test the tooltip host makes), taking no
 * focus and no pointer, and only ever for a line that is actually elided – measured at the
 * hover, the focus or the hold, never watched (`elidedAddressOf`). It goes on any press, a
 * wheel, a scroll, a key, the window's blur or resize, a popover or dialog opening, or its row
 * leaving the DOM. No native `title` anywhere (§9.31's one vocabulary): the row's DOM already
 * holds the whole value for a reader (#685), so the card describes nothing twice.
 *
 * A touch or pen pointer resting on a row shows no card (§9.31: hover is "mouse and keyboard
 * only"); its hold is the reveal on touch (§9.2). Where the page draws sheets (`hold` given –
 * the phone layout, and the two panes inside the phone shell), a hold on a shortened row opens
 * the row's hold sheet (`AddressSheet`, sheets.tsx) with the label as its title and the whole
 * value as the title block's paragraph. Where it draws dialogs (`hold` absent – the desktop's
 * two panes, and a tablet's: the lead's look on #694, point 4, "a finger on a tablet is
 * touch"), the hold raises the same card under the row through the machine's standing mode
 * (`addressHold`: at once, no leave timer), placed as the mouse's card is, and it stands until
 * a tap outside (a press elsewhere), a scroll or a wheel, Escape or another key, the window's
 * blur or resize, or a surface opening takes it down – the dismissals below, the tab card's
 * set. Live rows lie under that card, so unlike the mouse's it takes the pointer
 * (`data-by="hold"`, main.css): a tap on the card itself keeps it up and reaches no row – the
 * tab card, which no pointer reaches, has no such exemption – and its text is not selectable (no
 * hidden copy on the card). A second hold on another row moves the card there. The hold is
 * `useLongPress`'s (components/phone): recognised at `LONG_PRESS_MS` with `SLOP` of travel,
 * fired on the click the lift raises (or `RELEASE_DELAY_MS` after the lift when none comes) so
 * the sheet cannot receive that click, or at once on the `contextmenu` Chromium raises for a
 * touch hold, and the click swallowed either way. That hook spreads onto one element; a hold
 * heard for every row from the document reads its constants and keeps its rules. A row that
 * copies on the hold (`RowCopy`, SET-54: `data-copies`) keeps its copy and gets neither sheet
 * nor card – none carries an address today; the day one does, the copy is the sheet's Copy
 * row (§9.31's link-menu precedent), not a second gesture on the same hold.
 */
export function AddressReveal({
  root,
  hold
}: {
  /** The page layout's root: the rows this host answers for. */
  root: RefObject<HTMLElement | null>
  /**
   * Opens the hold sheet; absent where the page draws dialogs (the desktop's and a tablet's
   * two panes), where the hold raises the card instead.
   */
  hold?: (request: AddressHoldRequest) => void
}): JSX.Element | null {
  const { card, subject, held } = addressRevealStore.use()
  const holdRef = useRef(hold)
  useEffect(() => {
    holdRef.current = hold
  })
  const owned = (row: HTMLElement): boolean =>
    (root.current?.contains(row) ?? false) || insideFrameDialog(row)
  const shown = subject !== null && card.anchor !== null && owned(subject.row)
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)

  // The document's events, once, for every row now or later in the DOM.
  useEffect(() => {
    const mouse = (e: PointerEvent): boolean => e.pointerType === 'mouse' || e.pointerType === ''
    const mine = (subject: AddressSubject | null): AddressSubject | null =>
      subject && owned(subject.row) ? subject : null
    const onOver = (e: PointerEvent): void => {
      if (!mouse(e)) return
      const next = mine(addressRowOf(e.target))
      const prev = mine(addressRowOf(e.relatedTarget))
      if (next?.row === prev?.row) return
      if (prev) addressPointerLeave(prev.row)
      if (next) {
        const elided = elidedAddressOf(next.row)
        if (elided) addressPointerEnter(elided)
      }
    }
    const onOut = (e: PointerEvent): void => {
      if (!mouse(e)) return
      const prev = mine(addressRowOf(e.target))
      if (prev && prev.row !== addressRowOf(e.relatedTarget)?.row) addressPointerLeave(prev.row)
    }
    const onFocusIn = (e: FocusEvent): void => {
      const next = mine(elidedAddressOf(e.target))
      if (next && e.target instanceof HTMLElement && keyboardFocus(e.target)) addressFocus(next)
    }
    const onFocusOut = (e: FocusEvent): void => {
      const prev = mine(addressRowOf(e.target))
      if (prev) addressBlur(prev.row)
    }

    // The hold: one touch at a time, from the down to the click its lift raises.
    let press: { id: number; x: number; y: number; subject: AddressSubject } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let held = false
    let release: ReturnType<typeof setTimeout> | null = null
    let swallow = false
    /** The subject a recognised hold fires for once the lift's click has come or been waited out. */
    let fired: AddressSubject | null = null
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      press = null
    }
    // The reveal a recognised hold makes: the row's sheet where the page draws sheets, the
    // standing card where it draws dialogs.
    const fire = (): void => {
      if (release !== null) clearTimeout(release)
      release = null
      const subject = fired
      fired = null
      if (!subject) return
      const sheet = holdRef.current
      if (sheet) {
        sheet({
          kind: 'address',
          rowId: subject.row.dataset.row ?? '',
          label: labelOf(subject.row) || subject.text,
          text: subject.text
        })
      } else {
        addressHold(subject)
      }
    }
    const onDown = (e: PointerEvent): void => {
      // A tap on the standing card is a tap on the card: it stays, and no row under it hears.
      if (insideCard(ref.current, e.target)) return
      hideAddressCard()
      clear()
      held = false
      if (mouse(e) || e.button !== 0 || !e.isPrimary) return
      const subject = elidedAddressOf(e.target)
      if (!subject) return
      // The sheet is the page root's rows' (a frame dialog draws none where sheets are); the
      // card is any row's the page answers for, a frame dialog's too, as the mouse's card is.
      const inside = holdRef.current
        ? (root.current?.contains(subject.row) ?? false)
        : owned(subject.row)
      if (!inside) return
      if (subject.row.hasAttribute('data-copies')) return
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, subject }
      timer = setTimeout(() => {
        timer = null
        held = true
        try {
          navigator.vibrate?.(8)
        } catch {
          /* not available */
        }
      }, LONG_PRESS_MS)
    }
    const onMove = (e: PointerEvent): void => {
      if (!press || press.id !== e.pointerId) return
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP) return
      // A move past the slop is a scroll: a hold that was on ends, one on its way is dropped.
      clear()
      held = false
    }
    const onUp = (e: PointerEvent): void => {
      if (!press || press.id !== e.pointerId) return
      const { subject } = press
      clear()
      if (!held) return
      held = false
      fired = subject
      swallow = true
      release = setTimeout(fire, RELEASE_DELAY_MS)
    }
    const onCancel = (e: PointerEvent): void => {
      if (!press || press.id !== e.pointerId) return
      clear()
      held = false
    }
    // Chromium's own long press (`contextmenu` from a touch, a little after the timer): the
    // hold's cue, as `useLongPress` takes it – it fires now and the lift's click is swallowed.
    // A hold on the standing card itself raises no menu and, as a tap on it, leaves it standing.
    const onContextMenu = (e: MouseEvent): void => {
      if (insideCard(ref.current, e.target)) {
        e.preventDefault()
        return
      }
      if (!press) return
      e.preventDefault()
      const { subject } = press
      clear()
      held = false
      fired = subject
      swallow = true
      fire()
    }
    const onClick = (e: MouseEvent): void => {
      if (!swallow) return
      swallow = false
      e.preventDefault()
      e.stopPropagation()
      if (release !== null) fire()
    }
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onCancel, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('click', onClick, true)
      clear()
      if (release !== null) clearTimeout(release)
      hideAddressCard()
    }
    // `owned` reads the root ref at the event; the listeners are the document's for the host's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The card's own size decides where it fits; measured once it has rendered its text, at the
  // height its content wants (a height cap from the last placement is lifted for the reading).
  const text = subject?.text ?? ''
  useLayoutEffect(() => {
    const el = ref.current
    if (!shown || !el || !card.anchor) {
      setBox(null)
      return
    }
    const capped = el.style.maxHeight
    el.style.maxHeight = 'none'
    const size = { width: el.offsetWidth, height: el.offsetHeight }
    el.style.maxHeight = capped
    setBox(placeAddressCard(card.anchor, viewportSize(), size))
  }, [shown, card.anchor, text])

  // A popover registering with the chrome layer, or a frame dialog opening: the card goes at
  // once, whether it is up or on its way.
  useEffect(
    () =>
      subscribePopovers((change) => {
        if (change === 'open' || change === 'all') hideAddressCard()
      }),
    []
  )

  // While the card is up: a press, a wheel, a scroll, a key, the window's blur or resize take
  // it down (the tab card's dismissals), and so does its row leaving the DOM (a section change
  // under a resting pointer; the tooltip host watches its control the same way). The one
  // exemption is the held card's own region: it takes the pointer, so a press or a long press
  // on it names it – a tap on the card keeps it (the lead's rule is a tap outside), and the
  // press reaches no row under it. The dismissals hand the listener its event; the mouse's card
  // takes no pointer, so no event ever names that one.
  useEffect(() => {
    if (!shown || !subject) return
    const unbind = bindHoverCardDismissals((e?: Event) => {
      if (
        e &&
        (e.type === 'pointerdown' || e.type === 'contextmenu') &&
        insideCard(ref.current, e.target)
      ) {
        return
      }
      hideAddressCard()
    })
    const gone = new MutationObserver(() => {
      if (!subject.row.isConnected) hideAddressCard()
    })
    gone.observe(document.body, { childList: true, subtree: true })
    return () => {
      unbind()
      gone.disconnect()
    }
  }, [shown, subject])

  if (!shown) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        id={ADDRESS_CARD_ID}
        role="tooltip"
        className="zen-tab-hover-card zen-address-hover-card zen-animate-pop"
        // A §9.20 panel (§9.31): a page surface in either layout, as the popovers beside it
        // in the chrome layer declare on their own roots (§9.29's two families).
        data-surface="page"
        data-side={box?.side}
        // What raised it: the pointer resting, keyboard focus, or a touch hold – the standing
        // card that takes the pointer (main.css).
        data-by={held ? 'hold' : (card.by ?? undefined)}
        style={{
          width: POPOVER_WIDTH.list,
          ...(box ? popoverStyle(box) : { left: 0, top: 0 }),
          visibility: box ? 'visible' : 'hidden'
        }}
      >
        <span className="zen-address-hover-card-value">{text}</span>
      </div>
    </ChromePortal>
  )
}

/**
 * Whether an event landed on the card itself. Only the held card takes the pointer
 * (`[data-by='hold']`, main.css); no event ever names the mouse's or the keyboard's.
 */
function insideCard(card: HTMLElement | null, target: EventTarget | null): boolean {
  return card !== null && target instanceof Node && card.contains(target)
}

/** The row's own label – the nearest row of the label is the row, not a nested option's. */
function labelOf(row: HTMLElement): string {
  for (const label of row.querySelectorAll<HTMLElement>('.zen-settings-label')) {
    if (label.closest('.zen-settings-row') === row) return label.textContent?.trim() ?? ''
  }
  return ''
}

/**
 * Whether the focus that landed on `focused` came from the keyboard – `:focus-visible` (a
 * pointer's press focuses a row without it), or a pane shortcut's landing (`KEYBOARD_FOCUS_ATTR`,
 * lib/panes.ts) – the tooltip host's test. A DOM without the pseudo-class (a test's) counts
 * every focus as the keyboard's.
 */
function keyboardFocus(focused: HTMLElement): boolean {
  if (focused.hasAttribute(KEYBOARD_FOCUS_ATTR)) return true
  try {
    return focused.matches(':focus-visible')
  } catch {
    return true
  }
}
