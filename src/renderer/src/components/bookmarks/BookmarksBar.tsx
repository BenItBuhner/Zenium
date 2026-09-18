import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { BookmarkNode, Rect, Tab, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, MOBILE_BOOKMARKS_ID, OTHER_BOOKMARKS_ID } from '@shared/bookmarks'
import { inputToUrl } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { dropStore } from '@renderer/lib/drag'
import { closeBookmarkChrome, openBookmarkChrome, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BarMenu, type BarMenuRoot } from './BarMenu'
import { BookmarkIcon } from './BookmarkRow'
import { ChipMotion } from './chipMotion'
import { toRect } from './popover'
import { nodeLabel, useBookmarkTree } from './tree'
import { useBarDrag } from './useBarDrag'

const OVERFLOW_ANCHOR = 'overflow'

/** An outside drag (a sidebar tab, a link from a page) hovering the bar. */
type ExternalHover = { kind: 'slot'; index: number } | { kind: 'folder'; folderId: string }

/**
 * The bookmarks bar: a strip of chips for the "Bookmarks bar" folder above the content frame.
 * Folders open panels, chips that do not fit collect behind a chevron, chips reorder by drag
 * with the neighbours sliding out of the way, and anything that carries a URL – a tab from the
 * sidebar, a link from a page – can be dropped on it to become a bookmark.
 */
export function BookmarksBar({
  state,
  tab,
  className
}: {
  state: UIState
  tab: Tab | null
  className?: string
}): JSX.Element {
  const tree = useBookmarkTree(state)
  const items = useMemo(() => tree.children(BOOKMARKS_BAR_ID), [tree])
  const other = useMemo(() => tree.children(OTHER_BOOKMARKS_ID), [tree])
  const mobile = useMemo(() => tree.children(MOBILE_BOOKMARKS_ID), [tree])
  const pinned = useMemo((): BookmarkNode[] => {
    const roots: BookmarkNode[] = []
    const otherRoot = tree.get(OTHER_BOOKMARKS_ID)
    const mobileRoot = tree.get(MOBILE_BOOKMARKS_ID)
    if (otherRoot && other.length) roots.push(otherRoot)
    if (mobileRoot && mobile.length) roots.push(mobileRoot)
    return roots
  }, [mobile, other, tree])
  const tabId = tab?.id ?? null
  const stripRef = useRef<HTMLDivElement>(null)
  const [motion] = useState(() => new ChipMotion())
  useEffect(() => () => motion.dispose(), [motion])

  // ---------------------------------------------------------------------------
  // Overflow: chips are laid out in one row; from the first that does not fit, they hide and
  // the chevron at the end lists them.
  // ---------------------------------------------------------------------------

  const [overflowFrom, setOverflowFrom] = useState(Number.POSITIVE_INFINITY)
  const measure = useCallback((): void => {
    const strip = stripRef.current
    if (!strip) return
    const limit = strip.clientWidth
    const chips = strip.querySelectorAll<HTMLElement>('[data-bm-chip]')
    let first = Number.POSITIVE_INFINITY
    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i]
      if (chip.offsetLeft + chip.offsetWidth > limit + 0.5) {
        first = i
        break
      }
    }
    setOverflowFrom((prev) => (prev === first ? prev : first))
  }, [])
  useLayoutEffect(measure, [measure, items])
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(measure)
    ro.observe(strip)
    return () => ro.disconnect()
  }, [measure])
  const visibleCount = Math.min(overflowFrom, items.length)
  const hidden = useMemo(() => items.slice(visibleCount), [items, visibleCount])

  // ---------------------------------------------------------------------------
  // Panels: a folder chip's contents, or the chips that did not fit
  // ---------------------------------------------------------------------------

  const [menu, setMenu] = useState<{ anchorId: string; anchor: Rect; bar: Rect } | null>(null)
  // Mirrors the `barMenuOpen` chrome flag this component holds, so the handlers can decide
  // synchronously whether the page behind still has to be captured or released: `opening` while
  // the page behind is being captured and the flag is not yet set, `open` once it is.
  const holdsChrome = useRef<'opening' | 'open' | null>(null)
  const chipEls = useRef(new Map<string, HTMLElement>())
  const barRef = useRef<HTMLDivElement>(null)
  // The overflow panel follows the chips it stands in for.
  const menuRoot = useMemo((): BarMenuRoot | null => {
    if (!menu) return null
    return menu.anchorId === OVERFLOW_ANCHOR
      ? { kind: 'overflow', items: hidden }
      : { kind: 'folder', id: menu.anchorId }
  }, [hidden, menu])

  const menuAnchorId = menu?.anchorId ?? null
  const closeMenu = useCallback(
    (opts?: { focusAnchor: boolean }): void => {
      if (!holdsChrome.current) return
      holdsChrome.current = null
      setMenu(null)
      // Escape hands focus back to the chip the panel hung from (§9.22); a click leaves it be.
      closeBookmarkChrome({ barMenuOpen: false }, { keepFocus: Boolean(opts?.focusAnchor) })
      if (opts?.focusAnchor && menuAnchorId) chipEls.current.get(menuAnchorId)?.focus()
    },
    [menuAnchorId]
  )

  // The chip a panel was last asked for, so a capture that finishes late does not show a stale one.
  const wantedAnchor = useRef<string | null>(null)
  const openMenu = useCallback(
    (anchorId: string): void => {
      const el = chipEls.current.get(anchorId)
      const barEl = barRef.current
      if (!el || !barEl) return
      const anchor = toRect(el.getBoundingClientRect())
      const bar = toRect(barEl.getBoundingClientRect())
      wantedAnchor.current = anchorId
      if (holdsChrome.current) {
        setMenu({ anchorId, anchor, bar })
        return
      }
      holdsChrome.current = 'opening'
      // The page behind is captured first so the panel is not hidden under the live view.
      void openBookmarkChrome({ barMenuOpen: true }, tabId).then(() => {
        if (holdsChrome.current !== 'opening') return
        holdsChrome.current = 'open'
        // The pointer may have moved on to another chip while the page was being captured.
        if (wantedAnchor.current === anchorId) setMenu({ anchorId, anchor, bar })
      })
    },
    [tabId]
  )

  // One popover at a time (§9.20): another surface taking the chrome flag (the star bubble
  // opening, a dialog) puts the panel away without a hand-off.
  useEffect(
    () =>
      uiStore.subscribe(() => {
        if (uiStore.get().barMenuOpen || holdsChrome.current !== 'open') return
        holdsChrome.current = null
        setMenu(null)
      }),
    []
  )

  // Nothing left to show: the panel goes.
  useEffect(() => {
    if (menu?.anchorId === OVERFLOW_ANCHOR && hidden.length === 0) closeMenu()
  }, [closeMenu, hidden.length, menu?.anchorId])
  // The chip the panel hangs from vanished (a removal, another window, sync).
  useEffect(() => {
    if (menu && menu.anchorId !== OVERFLOW_ANCHOR && !items.some((n) => n.id === menu.anchorId))
      closeMenu()
  }, [closeMenu, items, menu])
  // The bar going away (compact mode, the setting) releases the chrome it holds.
  const closeMenuRef = useRef(closeMenu)
  useEffect(() => {
    closeMenuRef.current = closeMenu
  }, [closeMenu])
  useEffect(() => () => closeMenuRef.current(), [])

  const toggleMenu = (anchorId: string): void => {
    if (menu?.anchorId === anchorId) closeMenu()
    else openMenu(anchorId)
  }

  // ---------------------------------------------------------------------------
  // Dragging a chip
  // ---------------------------------------------------------------------------

  const onHoldFolder = useCallback(
    (folderId: string | null): void => {
      if (folderId) openMenu(folderId)
      else closeMenu()
    },
    [closeMenu, openMenu]
  )
  const { drag, target, startDrag, ghostRef, justDragged } = useBarDrag({
    tree,
    barId: BOOKMARKS_BAR_ID,
    items,
    visibleCount,
    stripRef,
    motion,
    onHoldFolder
  })
  const liftedId = drag?.node.id ?? null
  const lifted = useRef<string | null>(null)
  useLayoutEffect(() => {
    lifted.current = liftedId
  }, [liftedId])

  // Chips that changed slot (a drop, a new bookmark, a removal, a sort) glide there; the one
  // being dragged stays put under its ghost.
  const orderKey = `${items.map((n) => n.id).join('|')}#${visibleCount}`
  useLayoutEffect(() => {
    motion.flip(lifted.current)
  }, [motion, orderKey])

  // ---------------------------------------------------------------------------
  // Drops from outside: a sidebar tab (pointer drag) or a link / URL text (HTML5 drag)
  // ---------------------------------------------------------------------------

  const tabDrag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const [external, setExternal] = useState<ExternalHover | null>(null)
  const tabHover = useMemo((): ExternalHover | null => {
    if (!tabDrag || !dropKey?.startsWith('bookmark:')) return null
    const [, parentId, index] = dropKey.split(':')
    if (parentId !== BOOKMARKS_BAR_ID) return { kind: 'folder', folderId: parentId }
    // The strip's free space files the tab after the last chip: the caret shows there.
    return { kind: 'slot', index: index === '' ? visibleCount : Number(index) }
  }, [dropKey, tabDrag, visibleCount])
  const outsideHover = tabHover ?? external

  const slotAt = (x: number): { index: number; folderId: string | null } => {
    let index = 0
    for (const node of items.slice(0, visibleCount)) {
      const rect = chipEls.current.get(node.id)?.getBoundingClientRect()
      if (!rect) continue
      const inset = rect.width * 0.25
      if (node.type === 'folder' && x >= rect.left + inset && x <= rect.right - inset)
        return { index, folderId: node.id }
      if (x > rect.left + rect.width / 2) index++
    }
    return { index, folderId: null }
  }

  const carriesUrl = (dt: DataTransfer): boolean =>
    dt.types.includes('text/uri-list') || dt.types.includes('text/plain')

  const onDragOver = (e: React.DragEvent): void => {
    if (!carriesUrl(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { index, folderId } = slotAt(e.clientX)
    setExternal(folderId ? { kind: 'folder', folderId } : { kind: 'slot', index })
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setExternal(null)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!carriesUrl(e.dataTransfer)) return
    e.preventDefault()
    setExternal(null)
    const dropped = droppedBookmark(e.dataTransfer)
    if (!dropped) return
    const { index, folderId } = slotAt(e.clientX)
    run('bookmark.create', {
      parentId: folderId ?? BOOKMARKS_BAR_ID,
      index: folderId ? undefined : index,
      title: dropped.title,
      url: dropped.url,
      type: 'url'
    })
  }

  // The insertion line of a drag, between two chips of the strip: a chip drag knows where its
  // slot is; an outside drag's slot is measured from the chips either side of it.
  const insertLine = useRef<HTMLSpanElement>(null)
  const showInsert = target?.kind === 'slot' || outsideHover?.kind === 'slot'
  useLayoutEffect(() => {
    const line = insertLine.current
    const strip = stripRef.current
    if (!line || !strip) return
    let x: number | null = null
    if (target?.kind === 'slot') x = target.lineX
    else if (outsideHover?.kind === 'slot') {
      const shown = items.slice(0, visibleCount)
      const gap = parseFloat(getComputedStyle(strip).columnGap) || 0
      if (outsideHover.index >= shown.length) {
        const last = shown.length ? chipEls.current.get(shown[shown.length - 1].id) : null
        const r = last?.getBoundingClientRect() ?? strip.getBoundingClientRect()
        x = last ? r.right + gap / 2 : r.left + 1
      } else {
        const r = chipEls.current.get(shown[outsideHover.index].id)?.getBoundingClientRect()
        x = r ? r.left - gap / 2 : null
      }
    }
    if (x === null) return
    line.style.transform = `translateX(${x - strip.getBoundingClientRect().left - 1}px)`
  }, [items, outsideHover, target, visibleCount])

  const dropFolderId =
    target?.kind === 'folder'
      ? target.folderId
      : outsideHover?.kind === 'folder'
        ? outsideHover.folderId
        : null

  // ---------------------------------------------------------------------------
  // Chips
  // ---------------------------------------------------------------------------

  // The roving tab stop is remembered by chip, so a reorder (a cut and paste, a drop) keeps it on
  // the same chip wherever that chip lands; its position is derived.
  const [focusId, setFocusId] = useState<string | null>(null)
  const focusIndex = useMemo(() => {
    if (focusId === OVERFLOW_ANCHOR) return hidden.length ? visibleCount : 0
    const at = focusId ? items.findIndex((n) => n.id === focusId) : -1
    return at >= 0 && at < visibleCount ? at : 0
  }, [focusId, hidden.length, items, visibleCount])
  const focusChip = (index: number): void => {
    const shown = items.slice(0, visibleCount)
    const ids = shown.map((n) => n.id)
    if (hidden.length) ids.push(OVERFLOW_ANCHOR)
    if (!ids.length) return
    const at = ((index % ids.length) + ids.length) % ids.length
    setFocusId(ids[at] ?? null)
    chipEls.current.get(ids[at] ?? '')?.focus()
  }

  const onStripKeyDown = (e: React.KeyboardEvent): void => {
    const total = visibleCount + (hidden.length ? 1 : 0)
    switch (e.key) {
      case 'ArrowRight':
        focusChip(focusIndex + 1)
        break
      case 'ArrowLeft':
        focusChip(focusIndex - 1)
        break
      case 'Home':
        focusChip(0)
        break
      case 'End':
        focusChip(total - 1)
        break
      case 'Delete': {
        const node = items[focusIndex]
        if (node && focusIndex < visibleCount) run('bookmark.remove', { ids: [node.id] })
        break
      }
      case 'F2': {
        const node = items[focusIndex]
        if (node && focusIndex < visibleCount)
          void openBookmarkChrome(
            { bookmarkEdit: { id: node.id, parentId: BOOKMARKS_BAR_ID, type: node.type } },
            tabId
          )
        break
      }
      case 'c':
      case 'x': {
        if (!(e.ctrlKey || e.metaKey)) return
        const node = items[focusIndex]
        if (node && focusIndex < visibleCount)
          run(e.key === 'x' ? 'bookmark.cut' : 'bookmark.copy', { ids: [node.id] })
        break
      }
      default:
        return
    }
    e.preventDefault()
  }

  // Ctrl+V with a chip focused: bookmarks cut or copied in the app land after it; failing that,
  // a URL on the clipboard becomes a new chip there (Chrome).
  const onStripPaste = (e: React.ClipboardEvent): void => {
    const pasted = droppedBookmark(e.clipboardData)
    const index = Math.min(focusIndex + 1, visibleCount)
    e.preventDefault()
    void cmd('bookmark.paste', { folderId: BOOKMARKS_BAR_ID, index }).then((moved) => {
      if (moved || !pasted) return
      run('bookmark.create', {
        parentId: BOOKMARKS_BAR_ID,
        index,
        title: pasted.title,
        url: pasted.url,
        type: 'url'
      })
    })
  }

  const openNode = (node: BookmarkNode, e: React.MouseEvent): void => {
    if (e.shiftKey && state.capabilities.windows) {
      run('bookmark.openInWindow', { ids: [node.id], private: false })
      return
    }
    run('bookmark.open', { id: node.id, newTab: e.ctrlKey || e.metaKey, tabId })
  }

  const contextMenu = (e: React.MouseEvent, node: BookmarkNode | null): void => {
    e.preventDefault()
    e.stopPropagation()
    run('bookmark.contextMenu', {
      ids: node ? [node.id] : [],
      folderId: BOOKMARKS_BAR_ID,
      x: e.clientX,
      y: e.clientY,
      surface: 'bar'
    })
  }

  // One ref callback for every chip, keyed by `data-bm-id`; its cleanup detaches the chip, so
  // the motion controller keeps each element for exactly as long as it is on screen.
  const attach = useCallback(
    (el: HTMLElement | null): (() => void) | undefined => {
      const id = el?.dataset.bmId
      if (!el || !id) return undefined
      chipEls.current.set(id, el)
      if (id !== OVERFLOW_ANCHOR) motion.attach(id, el)
      return () => {
        chipEls.current.delete(id)
        if (id !== OVERFLOW_ANCHOR) motion.attach(id, null)
      }
    },
    [motion]
  )

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Bookmarks bar"
      className={cn('zen-bm-bar zen-no-drag', className)}
      onContextMenu={(e) => contextMenu(e, null)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={stripRef}
        className="zen-bm-strip"
        onKeyDown={onStripKeyDown}
        onPaste={onStripPaste}
      >
        {tabDrag && (
          <span
            aria-hidden
            data-drop={`bookmark:${BOOKMARKS_BAR_ID}:`}
            className="absolute inset-0"
          />
        )}
        {items.length === 0 && !tabDrag && !external && (
          <span className="zen-bm-empty">
            Drag a tab or a link here, or right-click to add a page.
          </span>
        )}
        {items.map((node, i) => (
          <button
            key={node.id}
            ref={attach}
            type="button"
            data-bm-id={node.id}
            data-bm-chip={node.type}
            data-bm-anchor={node.type === 'folder' ? true : undefined}
            data-overflow={i >= visibleCount}
            data-open={menu?.anchorId === node.id}
            data-lifted={liftedId === node.id}
            data-target={dropFolderId === node.id}
            data-icon-only={node.type === 'url' && !node.title ? true : undefined}
            aria-label={node.type === 'url' && !node.title ? nodeLabel(node) : undefined}
            aria-haspopup={node.type === 'folder' ? 'menu' : undefined}
            aria-expanded={node.type === 'folder' ? menu?.anchorId === node.id : undefined}
            aria-hidden={i >= visibleCount || undefined}
            tabIndex={i === focusIndex && i < visibleCount ? 0 : -1}
            className="zen-bm-chip"
            title={node.url ?? undefined}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('[data-drop]')) return
              startDrag(e, node, e.currentTarget)
            }}
            onPointerEnter={() => {
              // With a panel open, hovering another folder switches to it (Chrome).
              if (menu && node.type === 'folder' && menu.anchorId !== node.id && !drag)
                openMenu(node.id)
            }}
            onFocus={() => setFocusId(node.id)}
            onClick={(e) => {
              if (justDragged()) return
              if (node.type === 'folder') toggleMenu(node.id)
              else openNode(node, e)
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return
              // Middle click: the page in a background tab; a folder's pages all at once (Chrome).
              if (node.type === 'url') run('bookmark.open', { id: node.id, newTab: true, tabId })
              else run('bookmark.openAll', { ids: [node.id] })
            }}
            onContextMenu={(e) => contextMenu(e, node)}
          >
            <BookmarkIcon node={node} className="h-4 w-4 shrink-0" />
            <span className="zen-bm-chip-label">{nodeLabel(node)}</span>
            {tabDrag && i < visibleCount && (
              <TabDropZones node={node} index={i} barId={BOOKMARKS_BAR_ID} />
            )}
          </button>
        ))}
        {showInsert && (
          <span
            ref={insertLine}
            aria-hidden
            className="zen-bm-insert"
            data-axis="x"
            style={{ top: 3, height: 20 }}
          />
        )}
      </div>
      {hidden.length > 0 && (
        <button
          ref={attach}
          type="button"
          data-bm-id={OVERFLOW_ANCHOR}
          data-bm-anchor
          data-open={menu?.anchorId === OVERFLOW_ANCHOR}
          data-icon-only
          tabIndex={focusIndex === visibleCount ? 0 : -1}
          aria-label={`${hidden.length} more ${hidden.length === 1 ? 'bookmark' : 'bookmarks'}`}
          aria-haspopup="menu"
          aria-expanded={menu?.anchorId === OVERFLOW_ANCHOR}
          className="zen-bm-chip px-1.5"
          onFocus={() => setFocusId(OVERFLOW_ANCHOR)}
          onPointerEnter={() => {
            if (menu && menu.anchorId !== OVERFLOW_ANCHOR && !drag) openMenu(OVERFLOW_ANCHOR)
          }}
          onKeyDown={onStripKeyDown}
          onClick={() => toggleMenu(OVERFLOW_ANCHOR)}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
      {pinned.map((node) => (
        <button
          key={node.id}
          ref={attach}
          type="button"
          data-bm-id={node.id}
          data-bm-anchor
          data-open={menu?.anchorId === node.id}
          data-target={dropFolderId === node.id}
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={menu?.anchorId === node.id}
          className="zen-bm-chip"
          onPointerEnter={() => {
            if (menu && menu.anchorId !== node.id && !drag) openMenu(node.id)
          }}
          onClick={() => toggleMenu(node.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            run('bookmark.contextMenu', {
              ids: [node.id],
              folderId: node.id,
              x: e.clientX,
              y: e.clientY,
              surface: 'bar'
            })
          }}
        >
          <BookmarkIcon node={node} className="h-4 w-4 shrink-0" />
          <span className="zen-bm-chip-label">{nodeLabel(node)}</span>
          {tabDrag && <span data-drop={`bookmark:${node.id}:`} className="absolute inset-0 z-10" />}
        </button>
      ))}

      {menu && menuRoot && (
        <BarMenu
          tree={tree}
          root={menuRoot}
          anchor={menu.anchor}
          bar={menu.bar}
          tabId={tabId}
          dropTarget={target}
          liftedId={liftedId}
          onClose={closeMenu}
        />
      )}

      {drag &&
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden
            className="zen-bm-chip zen-bm-ghost zen-bm-lift"
            data-into={target?.kind === 'folder'}
            style={{ width: drag.width, height: drag.height }}
          >
            <BookmarkIcon node={drag.node} className="h-4 w-4 shrink-0" />
            <span className="zen-bm-chip-label">{nodeLabel(drag.node)}</span>
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * While a sidebar tab is being dragged, each chip splits into drop zones for `lib/drag.ts`:
 * left half = before the chip, right half = after it, and a folder's middle = inside it.
 */
function TabDropZones({
  node,
  index,
  barId
}: {
  node: BookmarkNode
  index: number
  barId: string
}): JSX.Element {
  const folder = node.type === 'folder'
  return (
    <>
      <span
        data-drop={`bookmark:${barId}:${index}`}
        className={cn('absolute inset-y-0 left-0 z-10', folder ? 'w-1/4' : 'w-1/2')}
      />
      {folder && (
        <span
          data-drop={`bookmark:${node.id}:`}
          className="absolute inset-y-0 left-1/4 z-10 w-1/2"
        />
      )}
      <span
        data-drop={`bookmark:${barId}:${index + 1}`}
        className={cn('absolute inset-y-0 right-0 z-10', folder ? 'w-1/4' : 'w-1/2')}
      />
    </>
  )
}

/** The URL and a name for what an HTML5 drag carried: a link, or text that reads as a URL. */
function droppedBookmark(dt: DataTransfer): { url: string; title: string } | null {
  const uriList = dt.getData('text/uri-list')
  const uri = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  const text = dt.getData('text/plain').trim()
  const url = uri ?? inputToUrl(text)
  if (!url || url.startsWith('zen://')) return null
  let title = ''
  const html = dt.getData('text/html')
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    title = (doc.body.textContent ?? '').trim()
  }
  if (!title && text && text !== url) title = text
  if (!title) {
    try {
      title = new URL(url).hostname.replace(/^www\./, '') || url
    } catch {
      title = url
    }
  }
  return { url, title }
}
