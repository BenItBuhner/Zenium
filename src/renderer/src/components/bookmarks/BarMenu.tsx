import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { BookmarkNode, Rect } from '@shared/types'
import { BOOKMARKS_BAR_ID, type BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { pathForFile } from '@renderer/lib/dnd'
import { droppedBookmark, payloadKind } from '@renderer/lib/dropIntent'
import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'
import {
  ChromePortal,
  POPOVER_WIDTH,
  placePopover,
  popoverStyle,
  useLightDismiss,
  viewportSize,
  type DismissReason
} from '@renderer/lib/portals'
import { BookmarkIcon } from './BookmarkRow'
import { useScrolled } from './popover'
import { nodeLabel } from './tree'
import type { BarDropTarget } from './useBarDrag'

export type BarMenuRoot =
  /** A folder chip's panel. */
  | { kind: 'folder'; id: string }
  /** The overflow chevron's panel: the chips that did not fit. */
  | { kind: 'overflow'; items: BookmarkNode[] }

interface Props {
  tree: BookmarkTree
  root: BarMenuRoot
  /** The chip the panel hangs from, and the bar it sits in (the panel's top edge is the bar's bottom). */
  anchor: Rect
  bar: Rect
  /** The chip itself, for the layer's light dismiss: its own press closes the panel. */
  anchorEl: () => Element | null
  tabId: string | null
  /** A bar drag's target, so the row or folder about to take the drop is marked. */
  dropTarget: BarDropTarget | null
  liftedId: string | null
  /** `focusAnchor`: the keyboard closed the panel, so the chip it hung from takes focus back. */
  onClose: (opts?: { focusAnchor: boolean }) => void
}

const WIDTH = POPOVER_WIDTH.list

interface Nav {
  rootKey: string
  path: string[]
  active: number
}

/**
 * A folder's panel on the bookmarks bar (and the overflow panel): a desktop popover of the
 * folder's contents (design-language-v2-draft §9.20: 320 wide, flush with the bar's bottom edge,
 * start-aligned with its chip or end-aligned from the trailing half – flipped, slid or shrunk by
 * `placePopover` to stay 8px inside the window and on its chip – 60% of the window at most).
 * Subfolders push in from the right under a bar header with a back chevron and the folder's
 * name; going back slides the same way in reverse. Keyboard (§9.22): focus lands on the first
 * row, arrows and Tab move it and wrap, Enter opens, Right pushes, Left or Backspace comes back,
 * Escape closes and hands focus back to the chip. The chrome layer's light dismiss closes it
 * otherwise: a press anywhere else (consumed, §9.20 amended), its chip's own press (which hands
 * the chip the focus), a scroll, a resize, another popover; hovering another folder chip
 * switches the panel to it (`BookmarksBar`), which is not a close.
 */
export function BarMenu({
  tree,
  root,
  anchor,
  bar,
  anchorEl,
  tabId,
  dropTarget,
  liftedId,
  onClose
}: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const rootKey = root.kind === 'folder' ? root.id : 'overflow'
  // Where the panel is: the folders pushed in from the first level (the last one is on screen)
  // and the highlighted row. Kept for the root it was made for, so another chip taking over the
  // panel starts at its first level, and cut back to the deepest folder that still exists.
  const [nav, setNav] = useState<Nav>({ rootKey, path: [], active: 0 })
  const path = useMemo((): string[] => {
    if (nav.rootKey !== rootKey) return []
    const gone = nav.path.findIndex((id) => tree.get(id)?.type !== 'folder')
    return gone === -1 ? nav.path : nav.path.slice(0, gone)
  }, [nav, rootKey, tree])
  const active = nav.rootKey === rootKey && nav.path.length === path.length ? nav.active : 0
  const levelId = path.length ? path[path.length - 1] : null
  const folderId = levelId ?? (root.kind === 'folder' ? root.id : BOOKMARKS_BAR_ID)
  const items = useMemo(
    () =>
      levelId
        ? tree.children(levelId)
        : root.kind === 'folder'
          ? tree.children(root.id)
          : root.items,
    [levelId, root, tree]
  )
  const title = levelId ? (tree.get(levelId)?.title ?? '') : null

  const setActive = useCallback(
    (next: (a: number) => number): void =>
      setNav({ rootKey, path, active: Math.max(0, next(active)) }),
    [active, path, rootKey]
  )
  const push = useCallback(
    (id: string): void => setNav({ rootKey, path: [...path, id], active: 0 }),
    [path, rootKey]
  )
  const pop = useCallback((): void => {
    // Land on the folder that was just left.
    const parentItems =
      path.length > 1
        ? tree.children(path[path.length - 2])
        : root.kind === 'folder'
          ? tree.children(root.id)
          : root.items
    setNav({
      rootKey,
      path: path.slice(0, -1),
      active: Math.max(
        0,
        parentItems.findIndex((n) => n.id === levelId)
      )
    })
  }, [levelId, path, root, rootKey, tree])

  const box = placePopover(anchor, bar, viewportSize(), WIDTH)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolled = useScrolled(bodyRef)

  // The layer's light dismiss: the chip's own press closes the panel and keeps the keyboard, as
  // Escape does; any other outside press, a scroll or a resize closes it and leaves the focus be.
  useLightDismiss(
    panelRef,
    (reason: DismissReason) => onClose({ focusAnchor: reason === 'anchor' }),
    { anchor: anchorEl }
  )

  // Escape closes the level, then the panel; the chip takes the focus back (§9.22).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (path.length) pop()
      else onClose({ focusAnchor: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, path.length, pop])

  // ---------------------------------------------------------------------------
  // Push-in: the level on screen slides in while the one it replaces slides out, one spring.
  // ---------------------------------------------------------------------------

  const levelKey = `${rootKey}/${path.join('/')}`
  const [leaving, setLeaving] = useState<{
    items: BookmarkNode[]
    title: string | null
  } | null>(null)
  const enteringRef = useRef<HTMLDivElement>(null)
  const leavingRef = useRef<HTMLDivElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  const shown = useRef<{
    key: string
    rootKey: string
    depth: number
    items: BookmarkNode[]
    title: string | null
  } | null>(null)
  useLayoutEffect(() => {
    const prev = shown.current
    shown.current = { key: levelKey, rootKey, depth: path.length, items, title }
    // A level starts at its top; the sticky header's hairline follows the body's scroll.
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    if (!prev || prev.key === levelKey || prev.rootKey !== rootKey || reducedMotion()) return
    const dir = path.length > prev.depth ? 1 : -1
    setLeaving({ items: prev.items, title: prev.title })
    const entering = enteringRef.current
    if (entering) entering.style.transform = `translateX(${dir * WIDTH}px)`
    spring.current?.stop()
    spring.current = new SpringAnimation(
      SPRING_SNAPPY,
      (x) => {
        if (enteringRef.current) enteringRef.current.style.transform = `translateX(${dir * x}px)`
        if (leavingRef.current)
          leavingRef.current.style.transform = `translateX(${dir * (x - WIDTH)}px)`
      },
      () => {
        if (enteringRef.current) enteringRef.current.style.transform = ''
        setLeaving(null)
      }
    )
    spring.current.start(WIDTH, 0, 0)
    // The snapshot of the outgoing level is what the ref held a moment ago.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelKey])
  useEffect(
    () => () => {
      spring.current?.stop()
    },
    []
  )

  // The panel takes the keyboard while open: focus rests on the highlighted row (the first one
  // when a level opens) so the row's name is read out, and the panel hears the keys it bubbles.
  useEffect(() => {
    const rows = enteringRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    const row = rows?.[active] ?? rows?.[0]
    if (row) row.focus({ preventScroll: true })
    else panelRef.current?.focus({ preventScroll: true })
  }, [active, levelKey, rootKey])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const open = useCallback(
    (node: BookmarkNode, newTab: boolean): void => {
      run('bookmark.open', { id: node.id, newTab, tabId })
      onClose()
    },
    [onClose, tabId]
  )

  const activate = (node: BookmarkNode, newTab: boolean): void => {
    if (node.type === 'folder') push(node.id)
    else open(node, newTab)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const n = items.length
    const current = items[active]
    switch (e.key) {
      case 'ArrowDown':
        if (n) setActive((a) => (a + 1) % n)
        break
      case 'ArrowUp':
        if (n) setActive((a) => (a - 1 + n) % n)
        break
      case 'Home':
        setActive(() => 0)
        break
      case 'End':
        setActive(() => n - 1)
        break
      case 'ArrowRight':
        if (current?.type === 'folder') push(current.id)
        break
      case 'ArrowLeft':
      case 'Backspace':
        if (path.length) pop()
        else onClose({ focusAnchor: true })
        break
      case 'Enter':
      case ' ':
        if (current) activate(current, e.ctrlKey || e.metaKey)
        break
      case 'Delete':
        if (current) run('bookmark.remove', { ids: [current.id] })
        break
      case 'Tab':
        // Tab wraps inside the popover (§9.22): it walks the rows like the arrows do.
        if (n) setActive((a) => (a + (e.shiftKey ? n - 1 : 1)) % n)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const contextMenu = (e: React.MouseEvent, node: BookmarkNode | null): void => {
    e.preventDefault()
    e.stopPropagation()
    run('bookmark.contextMenu', {
      ids: node ? [node.id] : [],
      folderId,
      x: e.clientX,
      y: e.clientY,
      surface: 'bar'
    })
  }

  // ---------------------------------------------------------------------------
  // Drops from outside: a link or URL text from a page, a file from the OS (HTML5 drag)
  // ---------------------------------------------------------------------------

  // The panel files the drop where the pointer is – beside a row, into a folder row, at the end
  // of the list – by the rule a chip drag follows (`useBarDrag`), and shows it the same way. The
  // data is sealed until the drop: text that is not an address is let go then.
  const [external, setExternal] = useState<PanelTarget | null>(null)
  const externalTargetAt = (x: number, y: number): PanelTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bar-drop]')
    if (!el || !panelRef.current?.contains(el)) return null
    return panelTargetFor(tree, el, y)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (payloadKind(e.dataTransfer.types) === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setExternal(externalTargetAt(e.clientX, e.clientY))
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setExternal(null)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (payloadKind(e.dataTransfer.types) === null) return
    e.preventDefault()
    setExternal(null)
    const target = externalTargetAt(e.clientX, e.clientY)
    const dropped = droppedBookmark(e.dataTransfer, pathForFile)
    if (!target || !dropped) return
    run('bookmark.create', {
      parentId: target.kind === 'folder' ? target.folderId : target.parentId,
      index: target.kind === 'row' ? target.index : undefined,
      title: dropped.title,
      url: dropped.url,
      type: 'url'
    })
  }
  const shownTarget = dropTarget ?? external

  const renderLevel = (
    list: BookmarkNode[],
    heading: string | null,
    live: boolean
  ): JSX.Element => (
    <>
      {heading !== null && (
        <div className="zen-bm-popover-header" data-scrolled={(live && scrolled) || undefined}>
          <button
            type="button"
            className="zen-toolbar-button"
            aria-label="Back"
            tabIndex={-1}
            onClick={pop}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-0 flex-1 truncate">{heading}</span>
        </div>
      )}
      <div
        ref={live ? bodyRef : undefined}
        className="zen-bm-popover-body zen-bm-popover-list relative flex flex-col"
        data-bar-drop={live ? `list:${folderId}` : undefined}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) contextMenu(e, null)
        }}
      >
        {list.length === 0 && <div className="zen-bm-empty-row">Empty</div>}
        {list.map((node, i) => {
          // One highlight, native-menu style: the active row follows the pointer (also when a
          // level slides in under a resting pointer), and the keyboard moves it from there.
          const follow = (): void => {
            if (live && active !== i) setActive(() => i)
          }
          return (
            <button
              key={node.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-bar-drop={live ? `row:${node.id}` : undefined}
              data-active={live && i === active}
              data-target={shownTarget?.kind === 'folder' && shownTarget.folderId === node.id}
              data-lifted={node.id === liftedId}
              className="zen-bm-popover-row"
              title={node.url ?? undefined}
              onPointerEnter={follow}
              onPointerMove={follow}
              onClick={(e) => activate(node, e.ctrlKey || e.metaKey)}
              onAuxClick={(e) => {
                if (e.button === 1 && node.type === 'url') open(node, true)
              }}
              onContextMenu={(e) => contextMenu(e, node)}
            >
              <BookmarkIcon node={node} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{nodeLabel(node)}</span>
              {node.type === 'folder' && <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />}
            </button>
          )
        })}
        {live && shownTarget?.kind === 'row' && shownTarget.parentId === folderId && (
          <RowInsertLine target={shownTarget} />
        )}
      </div>
    </>
  )

  return (
    <ChromePortal>
      <div
        ref={panelRef}
        role="menu"
        aria-label={
          root.kind === 'folder' ? (tree.get(root.id)?.title ?? 'Folder') : 'More bookmarks'
        }
        tabIndex={-1}
        data-bar-panel
        data-append-target={shownTarget?.kind === 'append' && shownTarget.parentId === folderId}
        className="zen-bm-popover zen-animate-pop fixed z-[80] flex flex-col outline-none"
        style={popoverStyle(box)}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div ref={enteringRef} className="zen-bm-menu-level flex min-h-0 flex-col">
          {renderLevel(items, title, true)}
        </div>
        {leaving && (
          <div
            ref={leavingRef}
            aria-hidden
            className="zen-bm-menu-level pointer-events-none absolute inset-0 flex flex-col"
          >
            {renderLevel(leaving.items, leaving.title, false)}
          </div>
        )}
      </div>
    </ChromePortal>
  )
}

/** Where a drop lands in a panel: beside a row, into a folder row, or at the end of the list. */
type PanelTarget = Exclude<BarDropTarget, { kind: 'slot' }>

/**
 * The target under the pointer in a panel, read off the row (or the list's free space) the
 * pointer is over: the middle half of a folder row files the drop inside it, the halves of any
 * row are the slots before and after it (the rule `useBarDrag` follows for a chip).
 */
function panelTargetFor(tree: BookmarkTree, el: HTMLElement, y: number): PanelTarget | null {
  const [kind, id] = (el.dataset.barDrop ?? '').split(':')
  if (kind === 'list') {
    const folder = tree.get(id)
    return folder?.type === 'folder' ? { kind: 'append', parentId: id } : null
  }
  if (kind !== 'row') return null
  const row = tree.get(id)
  if (!row || row.parentId === null) return null
  const rect = el.getBoundingClientRect()
  const frac = (y - rect.top) / Math.max(1, rect.height)
  if (row.type === 'folder' && frac >= 0.25 && frac <= 0.75) return { kind: 'folder', folderId: id }
  const after = frac > 0.5
  const at = tree.children(row.parentId).findIndex((n) => n.id === id)
  return {
    kind: 'row',
    parentId: row.parentId,
    index: at === -1 ? tree.children(row.parentId).length : at + (after ? 1 : 0),
    rowId: id,
    position: after ? 'after' : 'before'
  }
}

/**
 * The insertion line between two rows of the panel: a 2px accent line, 8px short of the rows'
 * either end (the rows sit inside the list's 16px padding).
 */
function RowInsertLine({
  target
}: {
  target: Extract<BarDropTarget, { kind: 'row' }>
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const list = el?.parentElement
    const row = list?.querySelector<HTMLElement>(`[data-bar-drop="row:${target.rowId}"]`)
    if (!el || !list || !row) return
    const y = row.offsetTop + (target.position === 'after' ? row.offsetHeight : 0) - 1
    el.style.transform = `translateY(${y}px)`
  }, [target])
  return (
    <div
      ref={ref}
      aria-hidden
      className="zen-bm-insert"
      data-axis="y"
      style={{ top: 0, left: 24, right: 24 }}
    />
  )
}
