import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import { BOOKMARKS_BAR_ID, type BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'
import { BookmarkIcon } from './BookmarkRow'
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
  /** The chip the panel hangs from. */
  anchor: DOMRect
  tabId: string | null
  /** A bar drag's target, so the row or folder about to take the drop is marked. */
  dropTarget: BarDropTarget | null
  liftedId: string | null
  onClose: () => void
}

const WIDTH = 240
const MARGIN = 8

interface Nav {
  rootKey: string
  path: string[]
  active: number
}

/**
 * A folder's panel on the bookmarks bar (and the overflow panel): a desktop menu of the
 * folder's contents. Subfolders push in from the right with a back chevron and the folder's
 * name; going back slides the same way in reverse. Keyboard: arrows, Enter, Right to push,
 * Left or Backspace to come back, Escape to close.
 */
export function BarMenu({
  tree,
  root,
  anchor,
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

  const left = Math.min(Math.max(MARGIN, anchor.left), window.innerWidth - WIDTH - MARGIN)
  const top = anchor.bottom + 6

  // The panel takes the keyboard while open.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [rootKey])

  // Outside click closes; the chips decide for themselves (a click toggles, a hover switches).
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (!target || panelRef.current?.contains(target)) return
      if (target.closest('[data-bm-anchor]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (path.length) pop()
      else onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
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
        else onClose()
        break
      case 'Enter':
      case ' ':
        if (current) activate(current, e.ctrlKey || e.metaKey)
        break
      case 'Delete':
        if (current) run('bookmark.remove', { ids: [current.id] })
        break
      case 'Tab':
        onClose()
        return
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

  const renderLevel = (
    list: BookmarkNode[],
    heading: string | null,
    live: boolean
  ): JSX.Element => (
    <>
      {heading !== null && (
        <div className="zen-bm-menu-title">
          <button
            type="button"
            className="zen-toolbar-button h-7 w-7"
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
        className="relative flex flex-col overflow-y-auto"
        style={{ maxHeight: window.innerHeight - top - MARGIN - 12 - (heading !== null ? 28 : 0) }}
        data-bar-drop={live ? `list:${folderId}` : undefined}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) contextMenu(e, null)
        }}
      >
        {list.length === 0 && <div className="zen-bm-menu-row opacity-40">Empty</div>}
        {list.map((node, i) => (
          <button
            key={node.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-bar-drop={live ? `row:${node.id}` : undefined}
            data-active={live && i === active}
            data-target={dropTarget?.kind === 'folder' && dropTarget.folderId === node.id}
            data-lifted={node.id === liftedId}
            className="zen-bm-menu-row"
            title={node.url ?? undefined}
            onPointerMove={() => live && active !== i && setActive(() => i)}
            onClick={(e) => activate(node, e.ctrlKey || e.metaKey)}
            onAuxClick={(e) => {
              if (e.button === 1 && node.type === 'url') open(node, true)
            }}
            onContextMenu={(e) => contextMenu(e, node)}
          >
            <BookmarkIcon node={node} className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{nodeLabel(node)}</span>
            {node.type === 'folder' && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
          </button>
        ))}
        {live && dropTarget?.kind === 'row' && dropTarget.parentId === folderId && (
          <RowInsertLine target={dropTarget} />
        )}
      </div>
    </>
  )

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={
        root.kind === 'folder' ? (tree.get(root.id)?.title ?? 'Folder') : 'More bookmarks'
      }
      tabIndex={-1}
      data-bar-panel
      data-append-target={dropTarget?.kind === 'append' && dropTarget.parentId === folderId}
      className="zen-panel zen-bm-menu zen-animate-pop fixed z-[80] outline-none"
      style={{ left, top, width: WIDTH }}
      onKeyDown={onKeyDown}
    >
      <div ref={enteringRef} className="zen-bm-menu-level">
        {renderLevel(items, title, true)}
      </div>
      {leaving && (
        <div
          ref={leavingRef}
          aria-hidden
          className="zen-bm-menu-level pointer-events-none absolute inset-[6px]"
        >
          {renderLevel(leaving.items, leaving.title, false)}
        </div>
      )}
    </div>,
    document.body
  )
}

/** The insertion line between two rows of the panel, a 2px accent line with pill ends. */
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
      style={{ top: 0, left: 8, right: 8 }}
    />
  )
}
