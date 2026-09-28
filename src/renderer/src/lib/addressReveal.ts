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
 * on a mouse or under keyboard focus, the row's hold sheet on touch (`AddressReveal`, the
 * Settings page's host). Nothing here reads the row's model: the host finds the row under the
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

/** The card's state: the controller's slice (the row's key and box), and the row it names. */
export interface AddressRevealState {
  card: HoverCardState
  /** The row the card is up for and the value it shows; null while no card is. */
  subject: AddressSubject | null
}

export const addressRevealStore = createStore<AddressRevealState>(
  { card: HOVER_CARD_HIDDEN, subject: null },
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
/** The subject `measure` read for the card on its way: the store takes it as the card shows. */
let measured: AddressSubject | null = null

const slice: HoverCardStore = {
  get: () => addressRevealStore.get().card,
  set: (card) => {
    addressRevealStore.set({ card, subject: card.tabId === null ? null : measured })
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
 */
function measure(subject: AddressSubject): RowMeasure | null {
  if (!subject.row.isConnected || !isElided(subject.span)) return null
  measured = { ...subject, text: subject.span.textContent ?? '' }
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
