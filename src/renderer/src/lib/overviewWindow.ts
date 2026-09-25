import { createContext } from 'react'
import { flushSync } from 'react-dom'
import { OVERVIEW_GRID_GAP, OVERVIEW_GRID_GUTTER } from './layout'
import { createStore } from './store'

/*
 * The overview grid's WINDOW (W6-0, PERF-5's item (e)). The grid mounts every tab's cell – the
 * card's frame at its aspect, keyed for the glide and the morph – but builds only the cards the
 * window holds: the cells in the grid's view and one row's margin past each edge mount as cards,
 * the hero's whatever the window says; the rest mount as sized PLACEHOLDERS (the frame in the
 * surface tone, no title, favicon or picture work, out of the accessibility tree) and become
 * cards on a scroll that brings them within the window, and, once the overview has settled, in
 * idle time under a frame budget, nearest to the view first. The mount's first task is then
 * the header, the hero and the cards in view; the thirty-tab open's 55–96 ms build (the
 * program's item) is split across frames, none of them long (ruling 5). A cell never goes back
 * to a placeholder: the window only grows until every card is built.
 *
 * The mount has no layout to read yet, so its first render builds the cards a GUESS puts in
 * view (`guessWindow`: the grid's items laid into rows by the columns and the cards' aspect, the
 * hero's row at the view's foot when it must scroll into view, a row's margin); the commit's
 * layout effect then reads the real window (`readWindow`, `windowOf`) and fills what the guess
 * missed – in the same task, before the frame paints – so a mount whose guess is right builds
 * its cards in one pass, as the grid always did, and one whose guess is short builds the missed
 * row in a second. The guess errs towards more: it counts the grid's whole height as the view
 * (the header takes some of it) and ignores a group's header row.
 *
 * The model is pure (`windowOf`, `guessWindow`); the store says which cells are cards and each
 * cell reads its own key, so a fill step re-renders the cells it fills and nothing else – not
 * the grid, whose FLIP set and hero measure stay where the commit left them.
 */

/**
 * The grid's items in its order, for the guess: a `cell` is one slot of a row – a card (a tab's
 * cell, keyed by its id), or a cell that is not one (a folded group, a group of one, the New Tab
 * card); a `row` item is a group spanning the grid (`col-span-full`), its cards laid in rows of
 * the grid's columns under its header.
 */
export type GridItem =
  | { kind: 'cell'; key: string; card: boolean }
  | { kind: 'row'; key: string; cards: readonly string[] }

/**
 * A row's pitch in the grid: a card's height at the grid's column width plus the gap under it.
 * `aspect` is the card's width over its height (the phone's 3 / 4, the tablet's computed ratio).
 */
export function overviewRowPitch(gridWidth: number, columns: number, aspect: number): number {
  const column =
    (gridWidth - 2 * OVERVIEW_GRID_GUTTER - (columns - 1) * OVERVIEW_GRID_GAP) / columns
  if (!(column > 0) || !(aspect > 0)) return 0
  return column / aspect + OVERVIEW_GRID_GAP
}

/**
 * The mount's guess at the window, before the grid has a layout to read: the cards in the rows
 * the view holds plus one row's margin past each edge, in the grid's order. The view stands at
 * the grid's top, or – when the hero's row lies beyond the rows the view holds – ends at the
 * hero's row, where `scrollIntoView` (nearest) puts it. `viewHeight` is the grid's, `pitch` a
 * row's (`overviewRowPitch`); with no pitch or height to go by every card is guessed in.
 */
export function guessWindow(
  items: readonly GridItem[],
  hero: string | null,
  columns: number,
  viewHeight: number,
  pitch: number
): string[] {
  const rows: string[][] = []
  let heroRow = -1
  let row: string[] = []
  const flush = (): void => {
    if (row.length > 0) rows.push(row)
    row = []
  }
  const place = (key: string, card: boolean): void => {
    if (key === hero) heroRow = rows.length
    if (card) row.push(key)
    else row.push('')
    if (row.length >= columns) flush()
  }
  for (const item of items) {
    if (item.kind === 'cell') {
      place(item.key, item.card)
      continue
    }
    flush()
    if (item.key === hero) heroRow = rows.length
    for (const key of item.cards) place(key, true)
    flush()
  }
  flush()
  const cards = (from: number, to: number): string[] =>
    rows
      .slice(Math.max(0, from), Math.max(0, to))
      .flat()
      .filter((key) => key !== '')
  if (!(pitch > 0) || !(viewHeight > 0)) return cards(0, rows.length)
  const inView = Math.max(1, Math.ceil(viewHeight / pitch))
  const first = heroRow < inView ? 0 : heroRow - inView + 1
  return cards(first - 1, first + inView + 1)
}

/** A cell's box along the grid's scroll axis, in the same space as the view's. */
export interface CellBox {
  /** The cell's `data-cell` key: a tab id, `group:<id>`, or the New Tab card's. */
  key: string
  top: number
  bottom: number
  /** A tab's card (a cell with `data-tab-id`): what the window builds or defers. */
  card: boolean
  /**
   * The cell stands inside a folded group: clipped to the group's header, not in view whatever
   * its box says – a folded group is one card (v2 §9.34) and its members build in idle time.
   */
  folded: boolean
}

/** The grid's box along its scroll axis. */
export interface ViewBox {
  top: number
  bottom: number
}

/**
 * How far past the view the window reaches where no card is in view to size a row by: about a
 * row of cards as a share of the view's height (the phone's rows at 412 x 915 are ~28%; the
 * picture look-ahead in `OverviewCard` uses the same figure).
 */
const ROW_FALLBACK = 0.35

/**
 * The window over the grid's cells: `shown`, every cell within the view and one row's margin
 * (folded groups' members excepted), in the grid's order; `rest`, the cards outside it, nearest
 * to the view first – the order the idle fill takes. The margin is a row of cards: the tallest
 * card in view (the tablet's cards are wider and taller than the phone's; the row is what the
 * cards in view say it is), or `ROW_FALLBACK` of the view where none is.
 */
export function windowOf(
  view: ViewBox,
  cells: readonly CellBox[]
): { shown: string[]; rest: string[] } {
  let row = 0
  for (const cell of cells) {
    if (!cell.card || cell.folded) continue
    if (cell.bottom <= view.top || cell.top >= view.bottom) continue
    row = Math.max(row, cell.bottom - cell.top)
  }
  if (row <= 0) row = (view.bottom - view.top) * ROW_FALLBACK
  const shown: string[] = []
  const rest: Array<{ key: string; folded: number; distance: number; index: number }> = []
  cells.forEach((cell, index) => {
    const within = !cell.folded && cell.bottom > view.top - row && cell.top < view.bottom + row
    if (within) {
      shown.push(cell.key)
      return
    }
    if (!cell.card) return
    const distance =
      cell.top >= view.bottom
        ? cell.top - view.bottom
        : cell.bottom <= view.top
          ? view.top - cell.bottom
          : 0
    rest.push({ key: cell.key, folded: cell.folded ? 1 : 0, distance, index })
  })
  // The cards out of view by distance, then the folded groups' members (out of sight whatever
  // their box says), each in the grid's order.
  rest.sort((a, b) => a.folded - b.folded || a.distance - b.distance || a.index - b.index)
  return { shown, rest: rest.map((r) => r.key) }
}

/**
 * Read the grid's cells for the window: the scroller's box and every `[data-cell]` under it,
 * from one layout (the first rect forces it; the rest read it). Null when the grid has no
 * layout to read – a box without height, as in a DOM that lays nothing out – in which case the
 * grid builds every card, as it always did.
 */
export function readWindow(grid: HTMLElement): { view: ViewBox; cells: CellBox[] } | null {
  const box = grid.getBoundingClientRect()
  if (!(box.height > 0)) return null
  const cells: CellBox[] = []
  for (const el of grid.querySelectorAll<HTMLElement>('[data-cell]')) {
    const key = el.getAttribute('data-cell')
    if (!key) continue
    const r = el.getBoundingClientRect()
    cells.push({
      key,
      top: r.top,
      bottom: r.bottom,
      card: el.hasAttribute('data-tab-id'),
      folded: el.parentElement?.closest('.zen-group[data-collapsed]') != null
    })
  }
  return { view: { top: box.top, bottom: box.bottom }, cells }
}

interface OverviewWindowState {
  /** Every cell is a card: the grid measured nothing to window by. */
  all: boolean
  /** The cells built as cards, by key. Grows; never shrinks while the grid stands. */
  filled: ReadonlySet<string>
}

const EMPTY: ReadonlySet<string> = new Set()

export const overviewWindowStore = createStore<OverviewWindowState>(
  { all: false, filled: EMPTY },
  'overviewWindow'
)

/**
 * Whether the cards under it are windowed: `TabOverview` provides `true` over its grid, and a
 * card rendered anywhere else – a test's, a preview's – is a card, as it always was.
 */
export const OverviewWindowContext = createContext(false)

/**
 * Whether the cell is built as a card: its own key's word, so a fill re-renders it alone. An
 * `eager` cell (the hero's, the mount's guess) is a card whatever the store says, and a fill –
 * which its key may be part of – re-renders it not at all.
 */
export function useCardFilled(key: string, eager = false): boolean {
  return overviewWindowStore.use((s) => eager || s.all || s.filled.has(key))
}

/** Build these cells as cards (no change when they are). */
export function fillCards(keys: Iterable<string>): void {
  overviewWindowStore.set((s) => {
    let next: Set<string> | null = null
    for (const key of keys) {
      if (s.filled.has(key)) continue
      next ??= new Set(s.filled)
      next.add(key)
    }
    return next ? { filled: next } : {}
  })
}

/** No window: every cell a card (the grid had no layout to window by). */
export function fillEveryCard(): void {
  cancelFill()
  overviewWindowStore.set({ all: true })
}

/** Back to the start: nothing built – the next grid windows afresh. Cancels a pending fill. */
export function resetOverviewWindow(): void {
  cancelFill()
  overviewWindowStore.set({ all: false, filled: EMPTY })
}

/**
 * The idle fill's budget per callback, ms of the main thread: well under ruling 5's 50 ms line
 * with room for the frame's own work beside it, and enough for a few cards on a slow device (a
 * phone card builds in 1–3 ms; the emulator's swangle in 5–10).
 */
export const FILL_BUDGET_MS = 12
/** How long an idle callback waits for idle time before it runs anyway, one card at a time. */
const IDLE_TIMEOUT_MS = 400

let queue: string[] = []
let pending: { idle: boolean; id: number } | null = null

/**
 * Fill the cards in `order` (nearest first) in idle time: `requestIdleCallback` where the
 * platform has it, a frame where it has not, each callback building cards one by one under
 * `FILL_BUDGET_MS` of measured time and the idle deadline – the next card is taken only if the
 * last one's cost fits what is left – then asking for the next idle period. Each card is
 * rendered synchronously (`flushSync`) so its cost is the one measured. A new order replaces the
 * queue; a callback already asked for reads the queue it finds.
 */
export function scheduleFill(order: readonly string[]): void {
  queue = order.filter((key) => !overviewWindowStore.get().filled.has(key))
  if (queue.length === 0) {
    cancelFill()
    return
  }
  if (!pending) request()
}

/** Drop the queue and the callback asked for. */
export function cancelFill(): void {
  queue = []
  if (!pending) return
  if (pending.idle) cancelIdleCallback(pending.id)
  else cancelAnimationFrame(pending.id)
  pending = null
}

/** How many cards wait to be built. */
export function pendingFill(): number {
  return queue.length
}

function request(): void {
  if (typeof requestIdleCallback === 'function') {
    pending = { idle: true, id: requestIdleCallback(step, { timeout: IDLE_TIMEOUT_MS }) }
  } else {
    pending = { idle: false, id: requestAnimationFrame(() => step(null)) }
  }
}

function step(deadline: IdleDeadline | null): void {
  pending = null
  const start = performance.now()
  let spent = 0
  let last = 0
  while (queue.length > 0) {
    if (spent > 0) {
      if (spent + last > FILL_BUDGET_MS) break
      if (deadline && !deadline.didTimeout && deadline.timeRemaining() < last) break
    }
    const key = queue.shift()!
    if (overviewWindowStore.get().filled.has(key)) continue
    const before = performance.now()
    flushSync(() => fillCards([key]))
    last = performance.now() - before
    spent = performance.now() - start
  }
  if (queue.length > 0) request()
}
