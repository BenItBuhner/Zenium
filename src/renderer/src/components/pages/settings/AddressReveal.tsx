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
  breakable,
  controlUnder,
  elidedAddressOf,
  hideAddressCard,
  holdCopyOf,
  isElided,
  placeAddressCard,
  type AddressSubject,
  type HoldCopy
} from '@renderer/lib/addressReveal'
import { run } from '@renderer/lib/api'
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
 * holds the whole value for a reader (#685), so the card describes nothing twice. The card a
 * hold raises (below) is the one exception to the tooltip: it may carry an action, so it is a
 * `role="dialog"` named by the row's label (the lead's ruling on #709: "the hold-raised card
 * takes role="dialog" labelled by the row label ("Folder"), non-modal, dismissal returning
 * focus per §9.22; the mouse/keyboard card without an action stays role="tooltip"") – the same
 * element, the same chrome, no `aria-modal` (the page under it stays live, as it is), still
 * taking no focus on its raise; `aria-label` rather than `aria-labelledby`, since an info row's
 * label carries no id (`RowText` mints one for a control row's `aria-labelledby` alone) and the
 * host writes nothing into the page's rows. Focus it does take – Chromium focuses its Copy
 * button on the tap – goes back where it was when the finger came down (§9.22; the return
 * effect below).
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
 * heard for every row from the document reads its constants and keeps its rules – its control
 * rule too: a press on a control inside the row (Location's Change… button, a desktop switch's
 * box) arms no hold, so the control's own tap and slow press stay its own (`controlUnder`),
 * while a row that is itself the control (a pressable row, a picker's option) holds as any row.
 * A row that copies on the hold (`RowCopy`, SET-54: `data-copies`) keeps its copy and gets
 * neither sheet nor card. A row that both copies and carries an address (services seed #34;
 * the lead's rule on #694, point 3: "the hold opens the sheet and the copy becomes its one Copy
 * row"; on the tablet "the bare hold still reveals and doesn't copy. The held card carries Copy
 * as its single §9.20 footer action"; §9.2) is no `data-copies` row – it arms no hold of its
 * own (`InfoRowView`, rows.tsx) and hands the copy to this host on `data-copy-text` and
 * `data-copy-confirmation` (`holdCopyOf`) – so one hold is one act, and the hold's surface is
 * the copy's, standing for such a row whether or not its line is elided (a value that fits
 * still has its Copy): where the page draws sheets, the hold opens the row's sheet with the
 * whole value in the block and the copy as the one row under it (§9.31's link-menu precedent);
 * where it draws dialogs, the hold raises the standing card with the copy as its one footer
 * action – §9.20's first footer form, the value, 16, one right-aligned text button, Copy
 * (`.zen-address-hover-card-footer`, main.css) – which copies through the core's clipboard path
 * (`clipboard.writeText`, the row's own hold's), takes the card down and lets the toast say the
 * word. The mouse's and the keyboard's card carry no footer and no action (the lead's point 2:
 * no hidden gesture on a card; the hover card is a tooltip). Either surface draws the value
 * through `breakable`: a spaceless path breaks at its slashes and dots before it breaks inside
 * a name.
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
  const { card, subject, held, copy } = addressRevealStore.use()
  const holdRef = useRef(hold)
  useEffect(() => {
    holdRef.current = hold
  })
  const owned = (row: HTMLElement): boolean =>
    (root.current?.contains(row) ?? false) || insideFrameDialog(row)
  const shown = subject !== null && card.anchor !== null && owned(subject.row)
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  /**
   * Where focus goes back to when the held card leaves with the focus inside it (§9.22): the
   * element that held focus when the finger came down on the row – null for the body, nothing
   * to return to. Read at the down, not at the raise: the hold's own lift, a click on a static
   * row, has already cleared the page's focus by the time the card stands.
   */
  const returnTo = useRef<HTMLElement | null>(null)

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

    // The hold: one touch at a time, from the down to the click its lift raises. What it holds:
    // the row's address line, and – for a row that both copies and carries an address (seed
    // #34) – the copy its surface draws (the sheet's one Copy row, the held card's one footer
    // button), read off the row at the down – and what held focus at the down, for the held
    // card to give focus back to (`returnTo`).
    type Hold = { subject: AddressSubject; copy: HoldCopy | null; focus: HTMLElement | null }
    let press: ({ id: number; x: number; y: number } & Hold) | null = null
    // What holds focus as the finger comes down: the body is nothing to return to, and a focus
    // inside the standing card (its button pressed and not lifted) hands on that card's own
    // target – the card is leaving with this press.
    const focusBefore = (): HTMLElement | null => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active === document.body) return null
      return insideCard(ref.current, active) ? returnTo.current : active
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let held = false
    let release: ReturnType<typeof setTimeout> | null = null
    let swallow = false
    /** The hold a recognised hold fires for once the lift's click has come or been waited out. */
    let fired: Hold | null = null
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
      const found = fired
      fired = null
      if (!found) return
      const { subject, copy, focus } = found
      const sheet = holdRef.current
      if (sheet) {
        sheet({
          kind: 'address',
          rowId: subject.row.dataset.row ?? '',
          label: labelOf(subject.row) || subject.text,
          text: subject.text,
          ...(copy ? { copy } : {})
        })
      } else {
        // The card's return target is the hold's (the sheet has the sheet stack's own rules).
        returnTo.current = focus
        addressHold(subject, copy)
      }
    }
    const onDown = (e: PointerEvent): void => {
      // A tap on the standing card is a tap on the card: it stays, and no row under it hears.
      if (insideCard(ref.current, e.target)) return
      hideAddressCard()
      clear()
      held = false
      if (mouse(e) || e.button !== 0 || !e.isPrimary) return
      const subject = addressRowOf(e.target)
      if (!subject) return
      // A row that both copies and carries an address (seed #34) holds whether or not its line
      // is elided – the hold's surface, the sheet or the held card, is the copy's, so a value
      // that fits still has its Copy – and the copy rides with the hold. Any other row holds
      // for an elided line only, as the mouse hovers.
      const copy = holdCopyOf(subject.row)
      if (!copy && !isElided(subject.span)) return
      // A press on a control inside the row – Location's Change…, a desktop switch's box – is
      // the control's, whichever reveal the hold would make (`controlUnder`; `useLongPress`'s
      // rule): no hold arms, and the lift's click reaches the control. A row that is itself
      // the control (a pressable row, a picker's option) keeps its hold.
      if (controlUnder(e.target, subject.row)) return
      // The sheet is the page root's rows' (a frame dialog draws none where sheets are); the
      // card is any row's the page answers for, a frame dialog's too, as the mouse's card is.
      const inside = holdRef.current
        ? (root.current?.contains(subject.row) ?? false)
        : owned(subject.row)
      if (!inside) return
      if (subject.row.hasAttribute('data-copies')) return
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, subject, copy, focus: focusBefore() }
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
      const { subject, copy, focus } = press
      clear()
      if (!held) return
      held = false
      fired = { subject, copy, focus }
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
      const { subject, copy, focus } = press
      clear()
      held = false
      fired = { subject, copy, focus }
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

  // The card's own size decides where it fits; measured once it has rendered its text – and
  // its footer, where the held card carries one: the footer's height is the card's, so the flip
  // near the window's bottom reads it too – at the height its content wants (a height cap from
  // the last placement is lifted for the reading).
  const text = subject?.text ?? ''
  const footer = held && copy !== null
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
  }, [shown, card.anchor, text, footer])

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

  // §9.22 for the held card, a dialog (the lead's ruling on #709): it takes no focus on its
  // raise, but Chromium focuses its Copy button on the tap, and a focused button removed with
  // the card would leave the focus dropped on the body. So as the card leaves – on any of its
  // dismissals: the button's own press, a press outside, a scroll or a wheel, a key, the
  // window's blur or resize, a surface opening, its row leaving, a second hold – focus inside
  // it goes back where it was when the finger came down on the row (`returnTo`, the hold's
  // reading; the static row is no tab stop and is never the target), or off the button to the
  // body when nothing held it – the usual case on touch, since the hold's own lift cleared the
  // page's focus – and with no scroll either way. Focus outside the card is not the card's and
  // is left alone. The return listens to the store: the hide is set before React takes the node
  // down, while the host's own effect cleanups run after that deletion is committed, too late
  // to read where focus is. A press outside then lands where it lands – the browser's own focus
  // for that press follows the return (§9.22: a close by a click outside leaves focus where the
  // click landed).
  useEffect(() => {
    if (!shown || !held || !subject) return
    return addressRevealStore.subscribe(() => {
      const next = addressRevealStore.get()
      if (next.held && next.card.anchor !== null && next.subject?.row === subject.row) return
      const el = ref.current
      const active = document.activeElement
      if (!el || !(active instanceof HTMLElement) || !el.contains(active)) return
      const target = returnTo.current
      if (target && target.isConnected) target.focus({ preventScroll: true })
      else active.blur()
    })
  }, [shown, held, subject])

  if (!shown) return null
  // The held card's name (its `role="dialog"`): the row's label, as the hold sheet's title reads
  // it – "Folder" for the Sync page's Folder row – or the value where a row has none.
  const label = held && subject ? labelOf(subject.row) || text : undefined
  return (
    <ChromePortal>
      <div
        ref={ref}
        id={ADDRESS_CARD_ID}
        // A tooltip for the mouse and the keyboard (§9.31); the held card, which may carry an
        // action, a non-modal dialog named by its row (the lead's ruling on #709) – no
        // `aria-modal`, the page under it as live as it is.
        role={held ? 'dialog' : 'tooltip'}
        aria-label={label}
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
        {/* The whole value, breaking at its slashes and dots first (`breakable`), inside a name only when it must. */}
        <span className="zen-address-hover-card-value">{breakable(text)}</span>
        {footer && copy ? (
          // The held card's one action for a row that both copies and carries an address (seed
          // #34; the lead's rule): §9.20's first footer form – the value, 16, the verb, 16 to
          // the edge, no hairline – holding the chassis's text button, right-aligned. Copy first,
          // then the card down (the sheet's Copy row leaves its sheet the same way, sheets.tsx);
          // the toast is the core's, as for the row's own hold (`useCopyOnHold`, rows.tsx). A
          // plain button: the held card is the finger's, and the tab card has no controls to
          // take a keyboard rule from; the focus its tap gives it goes back with the card (the
          // return effect above, §9.22).
          <div className="zen-address-hover-card-footer">
            <button
              type="button"
              className="zen-v2-button"
              data-action="copy"
              onClick={() => {
                run('clipboard.writeText', { text: copy.text, confirmation: copy.confirmation })
                hideAddressCard()
              }}
            >
              Copy
            </button>
          </div>
        ) : null}
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
