import { createElement, Fragment, type ReactElement, type ReactNode } from 'react'
import type { Rect } from '@shared/types'
import { HoverCardController, type HoverCardStore, type RowMeasure } from './hoverCard'
import { placePopover, POPOVER_WIDTH, toRect, type PopoverBox, type Size } from './portals'
import { createStore } from './store'
import { tooltipBlocked } from './tooltip'
import { HOVER_CARD_HIDDEN, type HoverCardState } from './ui'

/**
 * §9.2's reveal for a path or an address a Settings row shortened (services seed #32; the
 * lead's ruling on #685 item 4): the row's description keeps its end and drops its start
 * (`.zen-settings-description-address`, blocks.tsx `Description`), the whole value stays in
 * the DOM, and the reveal shows it whole where the ellipsis actually fell – a §9.31 hover card
 * on a mouse or under keyboard focus, the same card standing under a touch hold where the page
 * draws dialogs (a tablet; the lead's look on #694: "a finger on a tablet is touch"), the row's
 * hold sheet where it draws sheets (`AddressReveal`, the Settings page's host). Nothing here
 * reads the row's model: the host finds the row under the
 * pointer, its address line and whether that line is elided, at the event – a hover, a focus,
 * a hold – and never on a timer or a resize (`isElided`: the span's scroll width past its
 * client width, the one reading CSS's `text-overflow` also made).
 *
 * The card's timing is the tab hover card's machine (`HoverCardController`, lib/hoverCard.ts:
 * Chrome's ~800 ms, the move without waiting, the 80 ms grace between neighbouring rows, focus
 * at once), keyed here by the row's element rather than a tab's id, and written to a store of
 * its own – the tab card's slice of the UI state stays the tab card's. Blocking is the
 * tooltip's rule, not the tab card's `chromeBusy`: "blocked from behind a surface, never
 * inside it" (`tooltipBlocked`, the lead's W5-1 ruling 5) – a picker dialog's or sheet's
 * options are rows too, and their card must not be refused by the very surface they stand in.
 */

/** The row's address line (`Description` with `address`; the modifier #685 introduced). */
export const ADDRESS_LINE_SELECTOR = '.zen-settings-description-address'
/** Every Settings row, the phone's, the desktop's and a picker's option (`RadioOption`). */
export const ADDRESS_ROW_SELECTOR = '.zen-settings-row'

/** A row that carries an address line: the row, its line, and the whole value the line holds. */
export interface AddressSubject {
  row: HTMLElement
  span: HTMLElement
  text: string
}

/** The element an event names, for a target that may be a text node. */
function elementOf(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

/**
 * The row under `target` and its own address line – the line whose nearest row is that row,
 * not a nested option's (a radio list's row holds its options, each a row itself) – or null
 * when the target is not in a row, or the row's description is prose.
 */
export function addressRowOf(target: EventTarget | null): AddressSubject | null {
  const row = elementOf(target)?.closest<HTMLElement>(ADDRESS_ROW_SELECTOR) ?? null
  if (!row) return null
  for (const span of row.querySelectorAll<HTMLElement>(ADDRESS_LINE_SELECTOR)) {
    if (span.closest(ADDRESS_ROW_SELECTOR) === row) {
      return { row, span, text: span.textContent ?? '' }
    }
  }
  return null
}

/**
 * Whether the line is actually shortened: its content wider than its box, the reading CSS's
 * `text-overflow` draws the ellipsis on. Taken at the event, never watched – a value that fits
 * gets no reveal, and one that stops fitting is measured again at the next hover or hold.
 */
export function isElided(span: HTMLElement): boolean {
  return span.scrollWidth > span.clientWidth
}

/** `addressRowOf`, for a row whose line is elided right now; a fitting value is no subject. */
export function elidedAddressOf(target: EventTarget | null): AddressSubject | null {
  const subject = addressRowOf(target)
  return subject && isElided(subject.span) ? subject : null
}

/**
 * The controls a hold never arms on – `useLongPress`'s rule, "controls inside the element keep
 * their own taps" (the independent review of #694, nit 3): a slow press on Location's Change…
 * button or a desktop switch's box is that control's press, not the row's hold, so its lift's
 * click must reach it. A row that is itself the control – a pressable row, a picker's option
 * (`RadioOption` is the button) – keeps its hold.
 */
export const HOLD_CONTROL_SELECTOR = 'button, input, select, textarea, a[href]'

/**
 * The control a press inside `row` landed on – one the hold leaves alone – or null when the
 * press landed on the row's own text, or on a row that is itself the control.
 */
export function controlUnder(target: EventTarget | null, row: HTMLElement): Element | null {
  const control = elementOf(target)?.closest(HOLD_CONTROL_SELECTOR) ?? null
  return control && control !== row ? control : null
}

/**
 * The copy a row that both copies on a hold and carries an address hands to the hold's surface
 * (services seed #34; the lead's rule on #694, point 3: "when a row both copies on hold and
 * carries an address, the hold opens the sheet and the copy becomes its one Copy row", and on
 * the tablet "the held card carries Copy as its single §9.20 footer action"; §9.2). Such a row
 * arms no hold of its own and is no `data-copies` row – that marker means "copies itself on the
 * hold" to the preview host's `hold:` finder and the Android demo – and carries the copy on
 * these two attributes instead (`InfoRowView`, rows.tsx), for the host to read at the hold the
 * way it reads the row's address line: from the DOM, never from the model. The sheet draws it
 * as its one Copy row where the page draws sheets; the held card as its one footer button
 * where it draws dialogs; the mouse's and the keyboard's card never carry it.
 */
export const HOLD_COPY_TEXT_ATTR = 'data-copy-text'
export const HOLD_COPY_CONFIRMATION_ATTR = 'data-copy-confirmation'

/** What the hold's Copy copies (`RowCopy`'s shape): the text, and the toast's word for it. */
export interface HoldCopy {
  text: string
  confirmation: string
}

/** The copy `row` hands the hold's surface, or null for a row that carries none. */
export function holdCopyOf(row: HTMLElement): HoldCopy | null {
  const text = row.getAttribute(HOLD_COPY_TEXT_ATTR)
  const confirmation = row.getAttribute(HOLD_COPY_CONFIRMATION_ATTR)
  return text !== null && confirmation !== null ? { text, confirmation } : null
}

/**
 * The value with a break opportunity after each of its separators – a `<wbr>` after every `/`
 * and `.` – so a spaceless path or host breaks at its slashes and dots (§9.23: "a host too long
 * for a line breaking at its dots") before `overflow-wrap: anywhere` has to break it inside a
 * name; that rule stays on both surfaces as the fallback for one segment longer than the line
 * (the independent review of #694, nit 5). Nothing changes for a reader or for `textContent`
 * (a `<wbr>` has no text); the card's span and the hold sheet's paragraph draw it.
 */
export function breakable(text: string): ReactElement {
  const children: ReactNode[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '/' && ch !== '.') continue
    children.push(text.slice(start, i + 1), createElement('wbr', { key: i }))
    start = i + 1
  }
  if (start < text.length) children.push(text.slice(start))
  return createElement(Fragment, null, ...children)
}

/** The card's state: the controller's slice (the row's key and box), and the row it names. */
export interface AddressRevealState {
  card: HoverCardState
  /** The row the card is up for and the value it shows; null while no card is. */
  subject: AddressSubject | null
  /**
   * Whether a touch hold raised the card (`addressHold`): the standing card of a tablet, which
   * takes the pointer so that a tap on it falls through to no row under it. False for the
   * mouse's and the keyboard's, and while no card is.
   */
  held: boolean
  /**
   * The copy the held card carries as its one footer action – a row that both copies and
   * carries an address, held (seed #34; the lead: "the held card carries Copy as its single
   * §9.20 footer action"). Null for the mouse's and the keyboard's card, for an address-alone
   * row's held card, and while no card is.
   */
  copy: HoldCopy | null
}

export const addressRevealStore = createStore<AddressRevealState>(
  { card: HOVER_CARD_HIDDEN, subject: null, held: false, copy: null },
  'addressReveal'
)

// The controller's keys are strings (a tab's id for the tab card): a row's is minted once per
// element and kept for as long as the element lives.
const keys = new WeakMap<HTMLElement, string>()
let minted = 0
function keyOf(row: HTMLElement): string {
  let key = keys.get(row)
  if (!key) {
    key = `address-row-${++minted}`
    keys.set(row, key)
  }
  return key
}

/** The row the controller is asked about right now: `blocked` reads the surface it stands in. */
let candidate: HTMLElement | null = null
/** What `measure` read for the card on its way – the subject, whether a hold asked, and the copy a hold carried: the store takes it as the card shows. */
let measured: { subject: AddressSubject; held: boolean; copy: HoldCopy | null } | null = null

const slice: HoverCardStore = {
  get: () => addressRevealStore.get().card,
  set: (card) => {
    const up = card.tabId === null ? null : measured
    addressRevealStore.set({
      card,
      subject: up?.subject ?? null,
      held: up?.held ?? false,
      copy: up?.copy ?? null
    })
    if (card.tabId === null) measured = null
  }
}

/**
 * The card's machine: the tab card's timing (its delay, grace and one-at-a-time), blocked by
 * the tooltip's rule for the row asked about. Exported for the host and the tests.
 */
export const addressCard = new HoverCardController(slice, {
  blocked: () => candidate === null || tooltipBlocked(candidate)
})

/**
 * The row's geometry, read when the card shows – not when the pointer arrived (the machine's
 * rule) – and the elision read again with it: a row re-laid out during the wait so that its
 * value fits shows no card. The row is its own bar: the card hangs under it (`placeAddressCard`).
 * `held` marks the reading a touch hold asked for (`addressHold`); `copy` the copy that hold
 * carried, whose card stands whether or not the line is elided – the card is the copy's surface
 * too (the phone sheet's rule, seed #34), so a both-row whose value fits still has its Copy.
 */
function measure(
  subject: AddressSubject,
  held = false,
  copy: HoldCopy | null = null
): RowMeasure | null {
  if (!subject.row.isConnected || (!copy && !isElided(subject.span))) return null
  measured = { subject: { ...subject, text: subject.span.textContent ?? '' }, held, copy }
  const rect = toRect(subject.row.getBoundingClientRect())
  return { anchor: rect, sidebar: rect }
}

/** A mouse pointer came onto a row whose line is elided: its card after the delay, or at once if one is up. */
export function addressPointerEnter(subject: AddressSubject): void {
  candidate = subject.row
  addressCard.pointerEnter(keyOf(subject.row), () => measure(subject))
}

/** The mouse pointer left a row that carries an address line. */
export function addressPointerLeave(row: HTMLElement): void {
  addressCard.pointerLeave(keyOf(row))
}

/** Keyboard focus landed on (or inside) a row whose line is elided: its card at once (§9.22). */
export function addressFocus(subject: AddressSubject): void {
  candidate = subject.row
  addressCard.focus(keyOf(subject.row), () => measure(subject))
}

/** Focus left a row that carries an address line. */
export function addressBlur(row: HTMLElement): void {
  addressCard.blur(keyOf(row))
}

/**
 * A touch or pen held on a row whose line is elided, where the page draws no sheets (a tablet's
 * two panes; the lead's look on #694, point 4): its card at once, and standing – the
 * controller's focus mode, which no pointer leaving takes down – until a press elsewhere, a
 * scroll, a key, the window's blur or resize or a surface opening does (`AddressReveal` binds
 * `bindHoverCardDismissals`, the tab card's set). Marked `held` for the host: that card takes
 * the pointer. A second hold on another row moves it there (the press takes the first down, the
 * hold raises the next). `copy`, for a row that both copies and carries an address (seed #34):
 * the card carries it as its one footer action, Copy (`AddressReveal`), and stands for that row
 * whether or not its line is elided.
 */
export function addressHold(subject: AddressSubject, copy: HoldCopy | null = null): void {
  candidate = subject.row
  addressCard.focus(keyOf(subject.row), () => measure(subject, true, copy))
}

/** A press, a scroll, a key, the window's blur, a surface opening: no card shows or is about to. */
export function hideAddressCard(): void {
  addressCard.hide()
}

/**
 * Where the card goes, in viewport coordinates (§9.31 as the brief reads it for a row in a
 * column: "flush with the row's edge, start-aligned, flipping above near the bottom"): under
 * the row with its top flush on the row's bottom edge (gap 0), its start edge on the row's,
 * §9.20's list width, and §9.20's order past that through `placePopover` with the row as its
 * own bar – it flips above the row when its height would cross the window's bottom margin and
 * there is more room above (or the room below is under the 160 floor), slides inside the 8
 * margin when the start alignment does not fit, and shrinks to the window minus 16 when even
 * that is too wide.
 */
export function placeAddressCard(row: Rect, viewport: Size, size: Size): PopoverBox {
  return placePopover(row, row, viewport, POPOVER_WIDTH.list, size.height, 'start')
}
