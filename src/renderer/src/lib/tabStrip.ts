import type { FocusEvent, KeyboardEvent } from 'react'
import { useEffect } from 'react'
import { run } from './api'
import { releaseChromeFocus } from './panes'
import { browserStore, uiStore } from './ui'

/**
 * The tab strip's keyboard (a11y-07; the WAI-ARIA tabs pattern, vertical; Chrome's tab strip).
 *
 * The strip is one tab stop: a roving tabindex sits on the item the keyboard was last on – the
 * active row until then – so Tab leaves the strip in one press. Inside it, Up and Down walk the
 * items in the order they are drawn – the Essentials tiles, the pinned header and its rows, folder
 * headers and their rows, the loose rows – and wrap; Home and End jump to the ends; Enter or Space
 * activates a tab (the keyboard stays on the strip, as in Chrome) or folds a header; Delete closes
 * a tab and the keyboard moves to its neighbour; Left and Right fold and unfold a header (Chrome's
 * group header) or step along the tiles, Left from a row inside a folder goes up to its header
 * (the tree pattern); Escape gives the keyboard back to the page, as Chrome leaves a pane.
 *
 * Each item marks itself `data-strip-item` with its key – `tab:<id>` for a row or a tile,
 * `header:<spaceId>` for the pinned header, `folder:<id>` for a folder header – and, when a header
 * folds it, `data-strip-parent` with the header's key; headers carry `aria-expanded`. The pure part
 * ({@link stripIntent}) says what a key means for a list of items; {@link stripKeyDown} reads the
 * document and carries it out.
 */

export type StripItemKind = 'tile' | 'header' | 'folder' | 'tab'

export interface StripItem {
  /** `tile:<tabId>`, `tab:<tabId>`, `header:<spaceId>` or `folder:<folderId>`. */
  key: string
  /** The key of the header that folds this item, if one does. */
  parent: string | null
  /** For a header: whether its rows are out. */
  expanded?: boolean
}

export type StripIntent =
  | { type: 'focus'; index: number }
  | { type: 'activate' }
  | { type: 'fold'; expanded: boolean }
  | { type: 'close' }
  | { type: 'leave' }

export function stripItemKind(key: string): StripItemKind {
  const kind = key.slice(0, key.indexOf(':'))
  return kind === 'tile' || kind === 'header' || kind === 'folder' ? kind : 'tab'
}

const idOf = (key: string): string => key.slice(key.indexOf(':') + 1)

/**
 * What `key`, pressed on `items[at]`, means. `columns` is how many tiles the Essentials grid
 * puts on one line: Down from a tile goes to the tile under it while there is one. Null for a key
 * the strip does not take (Tab, letters, chords): the browser or the shortcut table has it.
 */
export function stripIntent(
  items: readonly StripItem[],
  at: number,
  key: string,
  columns = 1
): StripIntent | null {
  const item = items[at]
  if (!item) return null
  const kind = stripItemKind(item.key)
  const last = items.length - 1
  const kindAt = (i: number): StripItemKind | null =>
    items[i] ? stripItemKind(items[i].key) : null
  const focus = (index: number): StripIntent => ({ type: 'focus', index })
  const isHeader = kind === 'header' || kind === 'folder'
  switch (key) {
    case 'ArrowDown': {
      if (kind === 'tile') {
        if (kindAt(at + Math.max(1, columns)) === 'tile') return focus(at + Math.max(1, columns))
        const below = items.findIndex((it, i) => i > at && stripItemKind(it.key) !== 'tile')
        if (below !== -1) return focus(below)
      }
      return focus(at >= last ? 0 : at + 1)
    }
    case 'ArrowUp': {
      if (kind === 'tile' && at - Math.max(1, columns) >= 0) return focus(at - Math.max(1, columns))
      return focus(at <= 0 ? last : at - 1)
    }
    case 'Home':
      return focus(0)
    case 'End':
      return focus(last)
    case 'ArrowRight': {
      if (kind === 'tile') return kindAt(at + 1) === 'tile' ? focus(at + 1) : null
      if (!isHeader) return null
      if (item.expanded === false) return { type: 'fold', expanded: true }
      const child = items.findIndex((it) => it.parent === item.key)
      return child === -1 ? null : focus(child)
    }
    case 'ArrowLeft': {
      if (kind === 'tile') return kindAt(at - 1) === 'tile' ? focus(at - 1) : null
      if (isHeader) return item.expanded ? { type: 'fold', expanded: false } : null
      const parent = item.parent === null ? -1 : items.findIndex((it) => it.key === item.parent)
      return parent === -1 ? null : focus(parent)
    }
    case 'Enter':
    case ' ':
      return isHeader ? { type: 'fold', expanded: !item.expanded } : { type: 'activate' }
    case 'Delete':
      return isHeader ? null : { type: 'close' }
    case 'Escape':
      return { type: 'leave' }
    default:
      return null
  }
}

/** The strip items on screen under `root` (the tab strip pane), in the order they are drawn. */
export function stripEntries(root: HTMLElement): Array<{ el: HTMLElement; item: StripItem }> {
  return [...root.querySelectorAll<HTMLElement>('[data-strip-item]')]
    .filter(
      (el) =>
        el.dataset.stripItem &&
        el.getClientRects().length > 0 &&
        !el.closest('[inert], [aria-hidden="true"]')
    )
    .map((el) => {
      const expanded = el.getAttribute('aria-expanded')
      return {
        el,
        item: {
          key: el.dataset.stripItem ?? '',
          parent: el.dataset.stripParent ?? null,
          ...(expanded === null ? {} : { expanded: expanded === 'true' })
        }
      }
    })
}

/** How many tiles the Essentials grid holding `tile` puts on one line (1 when it cannot tell). */
function tileColumns(tile: HTMLElement): number {
  const grid = tile.parentElement
  if (!grid) return 1
  const view = grid.ownerDocument.defaultView
  const columns = view?.getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/) ?? []
  return Math.max(1, columns.filter((c) => c && c !== 'none').length)
}

/**
 * The strip item's `tabIndex`: 0 on the roving item – the one the keyboard is on, else the
 * `fallback` (the active row, or the folded header hiding it) – and -1 on every other, so the
 * strip is one tab stop. An item leaving the document while it holds the keyboard hands the stop
 * back to the fallback (a row removed under the keyboard sends no blur).
 */
export function useStripTabIndex(key: string, fallback: boolean): 0 | -1 {
  const roving = uiStore.use((s) => s.stripFocus)
  useEffect(
    () => () => {
      if (uiStore.get().stripFocus === key) uiStore.set({ stripFocus: null })
    },
    [key]
  )
  return (roving === null ? fallback : roving === key) ? 0 : -1
}

/** A strip item took the keyboard: it is the strip's tab stop until the keyboard leaves the strip. */
export function stripFocusIn(e: FocusEvent<HTMLElement>): void {
  if (e.target !== e.currentTarget) return
  const key = e.currentTarget.dataset.stripItem
  if (key && uiStore.get().stripFocus !== key) uiStore.set({ stripFocus: key })
}

/** The keyboard left a strip item; when it left the strip altogether the active row is the stop again. */
export function stripFocusOut(e: FocusEvent<HTMLElement>): void {
  if (e.target !== e.currentTarget) return
  const to = e.relatedTarget
  if (to instanceof Element && to.closest('[data-strip-item]')) return
  if (uiStore.get().stripFocus !== null) uiStore.set({ stripFocus: null })
}

/**
 * A key pressed on a strip item (the item itself, not a control inside it): carried out when the
 * strip takes it, else left to the browser and the shortcut table. Returns whether it was taken.
 */
export function stripKeyDown(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return false
  // Escape first clears a multi-selection (App's Escape chain); the strip keeps the keyboard.
  if (e.key === 'Escape' && uiStore.get().selectedTabIds.length > 0) return false
  const el = e.currentTarget
  const root = el.closest<HTMLElement>('[data-pane="tabs"]')
  if (!root) return false
  const entries = stripEntries(root)
  const at = entries.findIndex((entry) => entry.el === el)
  if (at === -1) return false
  const columns = stripItemKind(entries[at].item.key) === 'tile' ? tileColumns(el) : 1
  const intent = stripIntent(
    entries.map((entry) => entry.item),
    at,
    e.key,
    columns
  )
  if (!intent) return false
  e.preventDefault()
  e.stopPropagation()
  perform(intent, entries, at)
  return true
}

function perform(
  intent: StripIntent,
  entries: Array<{ el: HTMLElement; item: StripItem }>,
  at: number
): void {
  const { item } = entries[at]
  const kind = stripItemKind(item.key)
  const id = idOf(item.key)
  switch (intent.type) {
    case 'focus':
      entries[intent.index]?.el.focus()
      return
    case 'activate':
      run('tab.activate', { tabId: id, keepFocus: true })
      return
    case 'fold':
      if (kind === 'header') run('space.togglePinnedCollapsed', { spaceId: id })
      else run('folder.update', { folderId: id, patch: { collapsed: !intent.expanded } })
      return
    case 'close': {
      // A pinned or essential tab closed under Zen's pinned-close behaviour stays in the strip
      // (reset, unloaded), so the keyboard stays on it; a row that goes hands it to a neighbour.
      const state = browserStore.get().state
      const tab = state?.tabs[id]
      const stays =
        Boolean(tab && (tab.pinned || tab.essential)) &&
        state?.settings.pinnedCloseBehavior !== 'close'
      if (!stays) (entries[at + 1] ?? entries[at - 1])?.el.focus()
      run('tab.close', { tabId: id, keepFocus: true })
      return
    }
    case 'leave':
      releaseChromeFocus(entries[at].el.ownerDocument)
      run('focus.content', undefined)
      return
  }
}
