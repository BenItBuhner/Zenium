import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BookmarkNode, Rect } from '@shared/types'
import { BOOKMARKS_BAR_ID, type BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { popOrigin } from '@renderer/lib/anchor'
import { pathForFile } from '@renderer/lib/dnd'
import { droppedBookmark, payloadKind } from '@renderer/lib/dropIntent'
import { contextMenuAnchor, handleMenuKey } from '@renderer/lib/menuKeys'
import { openedFromKeyboard } from '@renderer/lib/popover'
import {
  ChromePortal,
  placePopover,
  popoverStyle,
  useLightDismiss,
  viewportSize,
  type DismissReason,
  type PopoverBox
} from '@renderer/lib/portals'
import { BookmarkIcon } from './BookmarkRow'
import { besideOrigin, layoutRect, placeBeside, rowRect } from './panelGeometry'
import { closedTo, focusAfterClose, focusAfterOpen, openedAt, type PathFocus } from './panelPath'
import { nodeLabel } from './tree'
import { HOLD_TO_OPEN_MS, type BarDropTarget } from './useBarDrag'

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

/** How long the pointer rests on a folder row before its panel opens beside it (Chrome, Firefox). */
export const HOVER_TO_OPEN_MS = 300

/** One open panel of the cascade: the folder whose contents it lists, and them. */
interface Level {
  folderId: string
  items: BookmarkNode[]
}

/** Where a level goes once measured, and where its pop grows from. */
interface Placement {
  box: PopoverBox
  origin: string
}

/**
 * Where the keyboard is to land once the level at `depth` stands: its first row (a level the
 * keyboard opened), the row of folder `id` (the level under it closed), or the panel itself,
 * which hears the keys without highlighting a row (opened by the pointer, §9.22).
 */
type FocusTarget = PathFocus['target'] | 'panel'
type FocusWanted = PathFocus | { depth: number; target: 'panel' }

/** Where a drop lands in a panel: beside a row, into a folder row, or at the end of the list. */
type PanelTarget = Exclude<BarDropTarget, { kind: 'slot' }>

/**
 * A folder's panel on the bookmarks bar (and the overflow panel): a page-family menu
 * (design-language-v2-draft §5, §6, §9.20) of the folder's contents on the shared `.zen-v2-menu`
 * – its intrinsic 232–332 sized to the longest row, `--v2-menu-row` rows with a 16 glyph and a
 * submenu chevron on a folder – hung from its chip by `placePopover` in measured-width mode
 * (flush with the bar's bottom edge, start- or end-aligned by the chip's half of the bar, flipped,
 * slid or shrunk to stay 8 inside the window) and popping from the chip. A folder row opens its
 * own panel beside the one it is in (`placeBeside`: its first row on the folder row, on the
 * trailing side unless only the leading one fits), after the pointer has rested on the row or
 * at once from the keyboard or a click; the folder row keeps the fill while its panel is open
 * (`aria-expanded`). No level has a title (pr-90 nit 3).
 *
 * Keyboard (§9.22): opened from the keyboard the first row takes focus, from the pointer the
 * panel itself does and the arrows start at the first row; Down, Up, Home, End and Tab move
 * through the level the focus is in, a letter goes to the row it names (Chrome's mnemonics),
 * Right opens a folder's panel on its first row, Left or Backspace closes the level and lands
 * on the folder that opened it, Escape closes one level at a time and, at the root, hands the
 * chip the focus back. The chrome layer's light dismiss closes the whole cascade otherwise: a
 * press anywhere else (consumed, §9.20 amended), its chip's own press (which hands the chip the
 * focus), a scroll outside it, a resize, another popover; hovering another folder chip hands
 * the panel to it (`BookmarksBar` mounts a `BarMenu` per chip), which is not a close.
 *
 * A chip drag (`useBarDrag`) or a link from a page files its drop at a row, into a folder row
 * or at the end of a level (§9.4): the target row or panel is marked, and resting on a folder
 * row for `HOLD_TO_OPEN_MS` opens its panel beside, as on a chip.
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
  const groupRef = useRef<HTMLDivElement>(null)
  const panelEls = useRef<Array<HTMLDivElement | null>>([])
  const rootFolderId = root.kind === 'folder' ? root.id : BOOKMARKS_BAR_ID
  const rootItems = useMemo(
    () => (root.kind === 'folder' ? tree.children(root.id) : root.items),
    [root, tree]
  )

  // The folders opened beside the root, outermost first, cut back to the deepest that is still
  // a folder in the level above it. `BookmarksBar` mounts one `BarMenu` per chip, so another
  // chip taking the panel over starts afresh.
  const [opened, setOpened] = useState<string[]>([])
  const path = useMemo((): string[] => {
    const kept: string[] = []
    let items = rootItems
    for (const id of opened) {
      const node = items.find((n) => n.id === id)
      if (!node || node.type !== 'folder') break
      kept.push(id)
      items = tree.children(id)
    }
    return kept
  }, [opened, rootItems, tree])
  const levels = useMemo((): Level[] => {
    const list: Level[] = [{ folderId: rootFolderId, items: rootItems }]
    for (const id of path) list.push({ folderId: id, items: tree.children(id) })
    return list
  }, [path, rootFolderId, rootItems, tree])
  const setPath = useCallback(
    (next: (path: string[]) => string[]): void => setOpened(next(path)),
    [path]
  )

  // Opened from the keyboard the first row takes the focus; from the pointer the panel does, so
  // it hears the keys and nothing is highlighted until the arrows or the pointer move (§9.22).
  // A level takes the focus once it stands (`MenuLevel`): a panel still hidden for measuring
  // cannot. A request is met in the commit that places its level, so a later change of the
  // path finds none pending and sets its own or none.
  const [focusWanted, setFocusWanted] = useState<FocusWanted | null>(() => ({
    depth: 0,
    target: openedFromKeyboard() ? 'first' : 'panel'
  }))
  const onFocused = useCallback((): void => setFocusWanted(null), [])

  // The moves through the cascade are `panelPath`'s (pure, tested there); `focus` says the
  // keyboard made the move, so the row it calls for takes the focus once its level stands.
  const openLevel = useCallback(
    (depth: number, folderId: string, focus: boolean): void => {
      setFocusWanted(focus ? focusAfterOpen(depth) : null)
      setPath((p) => openedAt(p, depth, folderId))
    },
    [setPath]
  )
  /** Close the levels deeper than `depth` (level `depth` stays); `focus` lands on the row that opened them. */
  const closeTo = useCallback(
    (depth: number, focus: boolean): void => {
      setFocusWanted(focus ? focusAfterClose(path, depth) : null)
      setPath((p) => closedTo(p, depth))
    },
    [path, setPath]
  )

  // The layer's light dismiss for the whole cascade: the chip's own press closes it and keeps
  // the keyboard, as Escape does; any other outside press, a scroll or a resize closes it and
  // leaves the focus be.
  useLightDismiss(
    groupRef,
    (reason: DismissReason) => onClose({ focusAnchor: reason === 'anchor' }),
    { anchor: anchorEl }
  )

  // Escape closes the deepest level, then the panel; the chip takes the focus back (§9.22).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (path.length) closeTo(path.length - 1, true)
      else onClose({ focusAnchor: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeTo, onClose, path.length])

  // ---------------------------------------------------------------------------
  // The pointer: a folder row opens beside after a rest, a plain row closes what is deeper
  // ---------------------------------------------------------------------------

  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHover = useCallback((): void => {
    if (hover.current !== null) clearTimeout(hover.current)
    hover.current = null
  }, [])
  useEffect(() => cancelHover, [cancelHover])
  const hoverRow = (depth: number, node: BookmarkNode): void => {
    cancelHover()
    const open = path[depth] ?? null
    const wanted = node.type === 'folder' ? node.id : null
    if (wanted === open) return
    hover.current = setTimeout(() => {
      hover.current = null
      if (wanted) openLevel(depth, wanted, false)
      else closeTo(depth, false)
    }, HOVER_TO_OPEN_MS)
  }

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

  const activate = (depth: number, node: BookmarkNode, newTab: boolean, focus: boolean): void => {
    cancelHover()
    if (node.type === 'folder') openLevel(depth, node.id, focus)
    else open(node, newTab)
  }

  /** The level the keyboard is in: the one holding the focus, else the deepest. */
  const focusedDepth = (): number => {
    const active = document.activeElement
    const at = panelEls.current.findIndex((el) => el?.contains(active))
    return at === -1 ? levels.length - 1 : at
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const depth = focusedDepth()
    const level = levels[depth]
    const rows = menuRows(panelEls.current[depth])
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const current = at === -1 ? undefined : level?.items[at]
    switch (e.key) {
      case 'ArrowRight':
        if (current?.type === 'folder') openLevel(depth, current.id, true)
        break
      case 'ArrowLeft':
      case 'Backspace':
        // The level in focus goes; its folder row, one level up, takes the focus.
        if (depth > 0) closeTo(depth - 1, true)
        else onClose({ focusAnchor: true })
        break
      case 'Enter':
      case ' ':
        if (current) activate(depth, current, e.ctrlKey || e.metaKey, true)
        break
      case 'Delete':
        if (current) run('bookmark.remove', { ids: [current.id] })
        break
      default:
        // The arrows, Home, End, Tab (wrapping inside the level, §9.22) and a letter, as in
        // Chrome's native menus: the next row whose name starts with it; the only such row
        // opens (a bookmark in this tab, a folder's level) off macOS.
        if (!handleMenuKey(e, rows, { mnemonics: true, tab: true })) return
        e.stopPropagation()
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const contextMenu = (e: React.MouseEvent, folderId: string, node: BookmarkNode | null): void => {
    e.preventDefault()
    e.stopPropagation()
    run('bookmark.contextMenu', {
      ids: node ? [node.id] : [],
      folderId,
      ...contextMenuAnchor(e),
      surface: 'bar'
    })
  }

  // ---------------------------------------------------------------------------
  // Drops: a chip from the bar (pointer drag), a link or URL text from a page, a file (HTML5 drag)
  // ---------------------------------------------------------------------------

  // The panels file the drop where the pointer is – beside a row, into a folder row, at the end
  // of a level – by the rule a chip drag follows (`useBarDrag`), and show it the same way. The
  // data is sealed until the drop: text that is not an address is let go then.
  const [external, setExternal] = useState<PanelTarget | null>(null)
  const externalTargetAt = (x: number, y: number): PanelTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bar-drop]')
    if (!el || !groupRef.current?.contains(el)) return null
    return panelTargetFor(tree, el, y)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (payloadKind(e.dataTransfer.types) === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const next = externalTargetAt(e.clientX, e.clientY)
    setExternal((prev) => (sameTarget(prev, next) ? prev : next))
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

  // Chrome's spring-open inside a panel: a drag resting on a folder row for the hold a chip
  // needs opens its panel beside; resting on a row of a shallower level closes what is deeper.
  const spring = useMemo((): { depth: number; folderId: string | null } | null => {
    if (!shownTarget || shownTarget.kind === 'slot') return null
    if (shownTarget.kind === 'folder') {
      const depth = levels.findIndex((l) => l.items.some((n) => n.id === shownTarget.folderId))
      return depth === -1 ? null : { depth, folderId: shownTarget.folderId }
    }
    const depth = levels.findIndex((l) => l.folderId === shownTarget.parentId)
    return depth === -1 ? null : { depth, folderId: null }
  }, [levels, shownTarget])
  const springKey = spring ? `${spring.depth}:${spring.folderId ?? ''}` : null
  useEffect(() => {
    if (!spring || (path[spring.depth] ?? null) === spring.folderId) return
    const timer = setTimeout(() => {
      if (spring.folderId) openLevel(spring.depth, spring.folderId, false)
      else closeTo(spring.depth, false)
    }, HOLD_TO_OPEN_MS)
    return () => clearTimeout(timer)
    // The key stands for the target; `path` moving is what the timer does, not a reason to restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeTo, openLevel, springKey])

  // ---------------------------------------------------------------------------
  // Placement: the root under its chip, every other level beside the row that opened it
  // ---------------------------------------------------------------------------

  const place = useCallback(
    (depth: number, folderId: string, el: HTMLElement): Placement | null => {
      const viewport = viewportSize()
      const size = { width: el.offsetWidth, height: el.offsetHeight }
      if (depth === 0) {
        const box = placePopover(anchor, bar, viewport, { measured: size.width }, size.height)
        return { box, origin: popOrigin(anchor, box) }
      }
      const parent = panelEls.current[depth - 1]
      const row = parent?.querySelector<HTMLElement>(`[data-bar-drop="row:${folderId}"]`)
      if (!parent || !row) return null
      const parentBox = layoutRect(parent)
      const rowBox = rowRect(row, parent, parentBox)
      const box = placeBeside(rowBox, parentBox, viewport, size)
      const height = Math.min(size.height, box.maxHeight)
      return { box, origin: besideOrigin(rowBox, box, viewport, height) }
    },
    [anchor, bar]
  )

  const label = root.kind === 'folder' ? (tree.get(root.id)?.title ?? 'Folder') : 'More bookmarks'

  return (
    <ChromePortal>
      <div
        ref={groupRef}
        className="contents"
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {levels.map((level, depth) => (
          <MenuLevel
            key={`${depth}/${level.folderId}`}
            ref={(el) => {
              panelEls.current[depth] = el
            }}
            depth={depth}
            level={level}
            label={depth === 0 ? label : (tree.get(level.folderId)?.title ?? 'Folder')}
            openId={path[depth] ?? null}
            target={shownTarget}
            liftedId={liftedId}
            focus={focusWanted?.depth === depth ? focusWanted.target : null}
            onFocused={onFocused}
            place={place}
            onEnterPanel={cancelHover}
            onHoverRow={hoverRow}
            onActivate={(node, newTab, focus) => activate(depth, node, newTab, focus)}
            onOpenInBackground={(node) => open(node, true)}
            onContextMenu={contextMenu}
            onScrolled={() => closeTo(depth, false)}
          />
        ))}
      </div>
    </ChromePortal>
  )
}

/** The rows of a panel, in order. */
function menuRows(panel: HTMLElement | null | undefined): HTMLElement[] {
  return [...(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
}

function sameTarget(a: PanelTarget | null, b: PanelTarget | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'folder') return b.kind === 'folder' && a.folderId === b.folderId
  if (a.kind === 'append') return b.kind === 'append' && a.parentId === b.parentId
  return (
    b.kind === 'row' &&
    a.parentId === b.parentId &&
    a.index === b.index &&
    a.rowId === b.rowId &&
    a.position === b.position
  )
}

/**
 * One panel of the cascade. It renders hidden at the window's origin first, so its intrinsic
 * width and height can be measured (layout size, not the client rect the pop animation's first
 * frame scales to .94), then takes the place `place` gives it; the placed width and height cap
 * are lifted for the measure when its rows change. Once it stands it takes the focus asked of it.
 */
function MenuLevel({
  ref,
  depth,
  level,
  label,
  openId,
  target,
  liftedId,
  focus,
  onFocused,
  place,
  onEnterPanel,
  onHoverRow,
  onActivate,
  onOpenInBackground,
  onContextMenu,
  onScrolled
}: {
  ref: (el: HTMLDivElement | null) => void
  depth: number
  level: Level
  label: string
  /** The folder whose panel is open beside this one. */
  openId: string | null
  target: PanelTarget | Extract<BarDropTarget, { kind: 'slot' }> | null
  liftedId: string | null
  /** Where the keyboard lands once the panel stands, if it is this panel's turn. */
  focus: FocusTarget | null
  onFocused: () => void
  place: (depth: number, folderId: string, el: HTMLElement) => Placement | null
  onEnterPanel: () => void
  onHoverRow: (depth: number, node: BookmarkNode) => void
  /** `focus`: the keyboard did it (Enter, a mnemonic), so a folder's level takes the focus. */
  onActivate: (node: BookmarkNode, newTab: boolean, focus: boolean) => void
  onOpenInBackground: (node: BookmarkNode) => void
  onContextMenu: (e: React.MouseEvent, folderId: string, node: BookmarkNode | null) => void
  /** The rows scrolled: whatever stood beside one of them no longer lines up. */
  onScrolled: () => void
}): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null)
  const { folderId, items } = level
  const [placed, setPlaced] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    node.style.width = ''
    node.style.maxHeight = ''
    setPlaced(place(depth, folderId, node))
  }, [depth, folderId, items.length, place])
  useLayoutEffect(() => {
    const node = el.current
    if (!node || !placed || !focus) return
    const rows = menuRows(node)
    const row =
      focus === 'panel'
        ? null
        : focus === 'first'
          ? rows[0]
          : rows.find((r) => r.dataset.barDrop === `row:${focus.id}`)
    ;(row ?? node).focus({ preventScroll: true })
    onFocused()
  }, [focus, onFocused, placed])
  return (
    <div
      ref={(node) => {
        el.current = node
        ref(node)
      }}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-bar-panel
      data-bar-drop={`list:${folderId}`}
      data-append-target={target?.kind === 'append' && target.parentId === folderId}
      className="zen-v2 zen-v2-panel zen-v2-menu zen-bm-panel zen-animate-pop"
      style={{
        ...(placed ? popoverStyle(placed.box) : { left: 0, top: 0 }),
        visibility: placed ? 'visible' : 'hidden',
        transformOrigin: placed?.origin
      }}
      onPointerEnter={onEnterPanel}
      onScroll={onScrolled}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) onContextMenu(e, folderId, null)
      }}
    >
      {items.length === 0 && (
        <button type="button" className="zen-v2-menu-item" disabled>
          <span className="zen-bm-panel-icon" />
          Empty
        </button>
      )}
      {items.map((node) => (
        <button
          key={node.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-bar-drop={`row:${node.id}`}
          data-target={target?.kind === 'folder' && target.folderId === node.id}
          data-lifted={node.id === liftedId}
          aria-haspopup={node.type === 'folder' ? 'menu' : undefined}
          aria-expanded={node.type === 'folder' ? openId === node.id : undefined}
          className="zen-v2-menu-item"
          title={node.url ?? undefined}
          onPointerEnter={() => onHoverRow(depth, node)}
          // A click the keyboard made (a mnemonic's, `detail` 0) is the keyboard's activation.
          onClick={(e) => onActivate(node, e.ctrlKey || e.metaKey, e.detail === 0)}
          onAuxClick={(e) => {
            if (e.button === 1 && node.type === 'url') onOpenInBackground(node)
          }}
          onContextMenu={(e) => onContextMenu(e, folderId, node)}
        >
          <BookmarkIcon node={node} className="zen-bm-panel-icon" />
          <span className="min-w-0 flex-1 truncate">{nodeLabel(node)}</span>
          {node.type === 'folder' && <ChevronRight className="zen-bm-panel-chevron" />}
        </button>
      ))}
      {target?.kind === 'row' && target.parentId === folderId && <RowInsertLine target={target} />}
    </div>
  )
}

/**
 * The target under the pointer in a panel, read off the row (or the panel's free space) the
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
 * The insertion line between two rows of a panel (§9.4): a 2px accent line as long as the rows'
 * text run (the rows stand 4 in from the panel's edges and hold 8 of padding, so 12 in).
 */
function RowInsertLine({
  target
}: {
  target: Extract<BarDropTarget, { kind: 'row' }>
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const panel = el?.parentElement
    const row = panel?.querySelector<HTMLElement>(`[data-bar-drop="row:${target.rowId}"]`)
    if (!el || !panel || !row) return
    const y = row.offsetTop + (target.position === 'after' ? row.offsetHeight : 0) - 1
    el.style.transform = `translateY(${y}px)`
  }, [target])
  return (
    <div
      ref={ref}
      aria-hidden
      className="zen-bm-insert"
      data-axis="y"
      style={{ top: 0, left: 12, right: 12 }}
    />
  )
}
