import { run } from './api'
import { dropStore } from './drag'
import {
  dropEffectFor,
  dropKeyFor,
  feedbackKeyFor,
  payloadKind,
  readInputs,
  slotInRows,
  type ChromeDropTarget,
  type PayloadKind,
  type RowPosition,
  type RowSpan
} from './dropIntent'
import { InsertionCaret, autoscrollStep } from './insertionCaret'
import { activeTab } from './selectors'
import { createStore } from './store'
import { browserStore, closeUrlbar, uiStore } from './ui'

/**
 * Drops onto the chrome from outside the tab strip (HTML5 drag and drop): a link or a selection
 * dragged out of a page, an address from another window, files from the OS. The classifier
 * (`lib/dropIntent.ts`) says what a drop does; this wires it to the document and drives the
 * feedback: the target's drop-into fill through `dropStore.key`, the insertion caret between
 * rows on its spring, and the tab list's autoscroll near its edges (design-language-v2-draft
 * §9.4).
 *
 * The page is a view of its own over the chrome: what is dropped on it never reaches this
 * document, so the page keeps its drops. The bookmarks bar and its folder panels take their own
 * drops (`BookmarksBar`, `BarMenu`); the internal pages and the new tab page, drawn by the
 * chrome in the page's frame, are left alone like a page. Nothing here answers `dragover` for a
 * drop it would not act on, so the cursor shows the no-drop badge there.
 */

/**
 * A chrome drop in progress: what the drag carries and what is under it. Components read it for
 * their feedback alongside `dropStore.key` (which carries the target's feedback key meanwhile).
 */
export const chromeDropStore = createStore<{
  kind: PayloadKind | null
  target: ChromeDropTarget | null
}>({ kind: null, target: null }, 'chromeDrop')

interface DragSession {
  kind: PayloadKind
  x: number
  y: number
  target: ChromeDropTarget | null
  frame: number | null
}

const SIDEBAR = 'aside[data-side]'
/** The page's frame: the new tab page, an internal page, the URL bar over them. */
const PAGE_FRAME = '[data-tear-zone]'
/** The URL bar's field, and the bar around it (its rows take no drop). */
const OMNIBOX = '.zen-omnibox'
const OMNIBOX_FIELD = '.zen-omnibox-input-row'

let session: DragSession | null = null
/** Where a drag that started in this document came from (the URL bar's own text, for one). */
let ownSource: Element | null = null
const caret = new InsertionCaret()

/** The chrome drop layer mounted (or unmounted) the caret element. */
export function registerChromeCaret(el: HTMLElement | null): void {
  caret.register(el)
}

/** Where a dropped file is on disk, through the preload (Electron's `webUtils.getPathForFile`). */
export function pathForFile(file: File): string | null {
  return window.zen.pathForFile?.(file) ?? null
}

/** Wire the document once; returns the teardown. */
export function installChromeDrops(): () => void {
  document.addEventListener('dragstart', onDragStart)
  document.addEventListener('dragend', onDragEnd)
  document.addEventListener('dragenter', onDragOver)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)
  return () => {
    document.removeEventListener('dragstart', onDragStart)
    document.removeEventListener('dragend', onDragEnd)
    document.removeEventListener('dragenter', onDragOver)
    document.removeEventListener('dragover', onDragOver)
    document.removeEventListener('dragleave', onDragLeave)
    document.removeEventListener('drop', onDrop)
    if (session) end(session)
  }
}

function onDragStart(e: DragEvent): void {
  ownSource = e.target instanceof Element ? e.target : null
}

function onDragEnd(): void {
  ownSource = null
  if (session) end(session)
}

function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return
  const kind = payloadKind(e.dataTransfer.types)
  if (!kind) return
  const s = session ?? begin(kind)
  s.kind = kind
  s.x = e.clientX
  s.y = e.clientY
  // Another handler took the drag (the bookmarks bar, a folder panel): nothing of ours lights up.
  const target = e.defaultPrevented ? null : resolveTarget(e.clientX, e.clientY)
  apply(s, target)
  if (e.defaultPrevented) return
  const key = dropKeyFor(kind, target)
  if (!key) return
  e.preventDefault()
  e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer.effectAllowed)
}

function onDragLeave(e: DragEvent): void {
  // Leaving for another element of the document names it (`relatedTarget`); leaving the document
  // – for the page's view, another window, or because the drag was cancelled – names nothing.
  if (session && !e.relatedTarget) end(session)
}

function onDrop(e: DragEvent): void {
  const s = session
  if (!e.dataTransfer || !s) return
  if (e.defaultPrevented) {
    end(s)
    return
  }
  const target = resolveTarget(e.clientX, e.clientY)
  const key = dropKeyFor(s.kind, target)
  end(s)
  if (!key) return
  e.preventDefault()
  const inputs = readInputs(e.dataTransfer, pathForFile)
  if (!inputs.length) return
  // A drop on the URL bar's field goes as a submit would, and the bar goes down like after one.
  if (target?.kind === 'address') closeUrlbar()
  run('drop.open', { inputs, key })
}

function begin(kind: PayloadKind): DragSession {
  const s: DragSession = { kind, x: 0, y: 0, target: null, frame: null }
  session = s
  chromeDropStore.set({ kind, target: null })
  scheduleAutoscroll(s)
  return s
}

function end(s: DragSession): void {
  if (session !== s) return
  session = null
  if (s.frame !== null) cancelAnimationFrame(s.frame)
  caret.hide()
  dropStore.set({ key: null })
  chromeDropStore.set({ kind: null, target: null })
}

/** The feedback for a target: the components' key, the caret in a slot. */
function apply(s: DragSession, target: ChromeDropTarget | null): void {
  s.target = target
  chromeDropStore.set({ target })
  dropStore.set({ key: feedbackKeyFor(s.kind, target) })
  const placement = target?.kind === 'tab' && target.position !== 'into' ? caretFor(target) : null
  if (placement) caret.show(placement)
  else caret.hide()
}

/**
 * Where the caret lies for a slot beside a tab row: in the gap under or over the row, 8 px short
 * of its ends (§9.4). An Essentials tile draws its own vertical caret (`zen-tab-caret-grid`).
 */
function caretFor(target: {
  tabId: string
  position: RowPosition
}): { x: number; y: number; width: number } | null {
  const row = document.querySelector<HTMLElement>(
    `.zen-tab[data-tab-id="${CSS.escape(target.tabId)}"]`
  )
  if (!row || row.offsetParent === null) return null
  const r = row.getBoundingClientRect()
  const list = row.parentElement
  const gap = list ? parseFloat(getComputedStyle(list).rowGap) || 0 : 0
  const y = target.position === 'before' ? r.top - gap / 2 : r.bottom + gap / 2
  return { x: r.left + 8, y, width: r.width - 16 }
}

/**
 * What lies under the pointer. The bookmarks bar and its panels answer for themselves and the
 * page's frame is the page's; then the address pill or the URL bar's field, a space, a folder,
 * the new-tab button, an Essentials tile or the grid, a slot of the tab list (its free space is
 * after the last row), the rest of the sidebar (after the last row of the active list), and the
 * rest of the window.
 */
function resolveTarget(x: number, y: number): ChromeDropTarget | null {
  const state = browserStore.get().state
  const under = document.elementFromPoint(x, y)
  if (!state || !under) return null
  if (under.closest('.zen-bm-bar, [data-bar-panel]')) return null
  const spaceId = state.activeSpaceId
  const readOnly = state.window.chrome === 'popup'
  if (under.closest(OMNIBOX_FIELD)) {
    const urlbar = uiStore.get().urlbar
    return {
      kind: 'address',
      tabId: urlbar.tabId,
      spaceId,
      readOnly,
      own: Boolean(ownSource?.closest(OMNIBOX))
    }
  }
  if (under.closest(`${OMNIBOX}, ${PAGE_FRAME}`)) return null
  if (under.closest('[data-address-pill]')) {
    return {
      kind: 'address',
      tabId: activeTab(state)?.id ?? null,
      spaceId,
      readOnly,
      own: Boolean(ownSource?.closest(`${OMNIBOX}, [data-zen-nav-row]`))
    }
  }
  const space = under.closest<HTMLElement>('[data-space-target]')
  if (space?.dataset.spaceTarget) return { kind: 'space', spaceId: space.dataset.spaceTarget }
  const folder = under.closest<HTMLElement>('[data-tab-folder]')
  if (folder?.dataset.tabFolder) return { kind: 'folder', folderId: folder.dataset.tabFolder }
  if (under.closest('[data-new-tab]')) return { kind: 'newTab', spaceId }
  const grid = under.closest<HTMLElement>('[data-essentials]')
  if (grid) {
    const tile = under.closest<HTMLElement>('.zen-essential[data-tab-id]')
    if (tile?.dataset.tabId) {
      // Tiles sit side by side in the grid, one under another in the collapsed sidebar.
      const r = tile.getBoundingClientRect()
      const columns = getComputedStyle(grid.querySelector('.grid') ?? grid).gridTemplateColumns
      const vertical = columns.split(' ').length <= 1
      const slot = slotInRows(
        vertical ? y : x,
        vertical
          ? [{ id: tile.dataset.tabId, start: r.top, end: r.bottom }]
          : [{ id: tile.dataset.tabId, start: r.left, end: r.right }]
      )
      if (slot) return { kind: 'tab', tabId: slot.id, position: slot.position }
    }
    return { kind: 'section', section: 'essential', spaceId: '' }
  }
  const scroller = under.closest<HTMLElement>('[data-tab-scroller]')
  if (scroller) {
    const slot = slotInRows(y, rowSpans(scroller))
    if (slot) return { kind: 'tab', tabId: slot.id, position: slot.position }
    return { kind: 'section', section: 'regular', spaceId }
  }
  if (under.closest(SIDEBAR)) return appendTarget(spaceId)
  return { kind: 'chrome', spaceId }
}

/** The rows of a list as drawn, top to bottom. */
function rowSpans(scroller: HTMLElement): RowSpan[] {
  return [...scroller.querySelectorAll<HTMLElement>('.zen-tab[data-tab-id]')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.tabId ?? '', start: r.top, end: r.bottom }
    })
    .sort((a, b) => a.start - b.start)
}

/** The end of the active space's list: after its last row, or the empty section. */
function appendTarget(spaceId: string): ChromeDropTarget {
  const scroller = document.querySelector<HTMLElement>('[data-tab-scroller][data-active="true"]')
  const rows = scroller ? rowSpans(scroller) : []
  const last = rows[rows.length - 1]
  if (last) return { kind: 'tab', tabId: last.id, position: 'after' }
  return { kind: 'section', section: 'regular', spaceId }
}

/**
 * Near the list's top or bottom edge the list scrolls under the pointer, faster the closer to
 * the edge (§9.4: within 32 px), and the target under the still pointer is re-read as it does.
 * Chromium fires `dragover` only as the pointer moves, so the scroll runs on frames of its own.
 */
function scheduleAutoscroll(s: DragSession): void {
  const tick = (): void => {
    s.frame = null
    if (session !== s) return
    const under = document.elementFromPoint(s.x, s.y)
    const scroller = under?.closest<HTMLElement>('[data-tab-scroller]') ?? null
    if (scroller) {
      const step = autoscrollStep(scroller.getBoundingClientRect(), s.x, s.y)
      if (step !== 0) {
        const before = scroller.scrollTop
        scroller.scrollTop += step
        if (scroller.scrollTop !== before) apply(s, resolveTarget(s.x, s.y))
      }
    }
    s.frame = requestAnimationFrame(tick)
  }
  s.frame = requestAnimationFrame(tick)
}
