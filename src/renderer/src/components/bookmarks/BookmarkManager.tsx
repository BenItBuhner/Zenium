import type { JSX, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownAZ,
  Check,
  Clock,
  Download,
  Ellipsis,
  ExternalLink,
  FolderPlus,
  FolderTree as FolderTreeIcon,
  Link,
  ListChecks,
  Plus,
  Star,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { BookmarkNode, Platform, UIState } from '@shared/types'
import {
  BOOKMARKS_BAR_ID,
  type BookmarkTree,
  defaultBookmarkFolderId,
  isBookmarkRoot,
  searchBookmarks,
  topLevelSelection
} from '@shared/bookmarks'
import { type ManagerSort, sortManagerRows } from '@shared/bookmarkViews'
import { cmd, run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { ChromePortal, FrameDialogHost } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, closeOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { EmptyNote, OverlayShell } from '../overlays/OverlayShell'
import { BookmarkIcon, BookmarkRow } from './BookmarkRow'
import { Breadcrumb } from './Breadcrumb'
import { DropIndicator } from './DropIndicator'
import { EditBookmarkDialog } from './EditBookmarkDialog'
import { FolderTree } from './FolderTree'
import { nodeLabel, useBookmarkTree } from './tree'
import { type BookmarkDrag, useBookmarkDrag } from './useBookmarkDrag'
import { useFlip } from './useFlip'
import { useEscapeTrap } from './escape'

const SEARCH_LIMIT = 200
const DRAG_THRESHOLD = 5
/** The drag ghost: a compact copy of the row, drawn a little to the side of the pointer. */
const GHOST_MAX_WIDTH = 320
const GHOST_GAP = 14

/**
 * The folder the manager opens on: the bookmarks bar on desktop (Chrome), the platform's own
 * root on phones; when that one is empty, the first root with anything in it.
 */
function initialFolder(tree: BookmarkTree, platform: Platform): string {
  const preferred = platform === 'android' ? defaultBookmarkFolderId(platform) : BOOKMARKS_BAR_ID
  if (tree.children(preferred).length) return preferred
  return tree.roots().find((r) => tree.children(r.id).length)?.id ?? preferred
}

/**
 * Chrome's bookmark manager: folders on the left, the shown folder's contents on the right,
 * search across the whole tree, drag and drop, sorting, multi-select, context menus and
 * keyboard navigation. On phones the tree stacks above the list behind a toggle.
 */
export function BookmarkManager({ state }: { state: UIState }): JSX.Element {
  const tree = useBookmarkTree(state)
  const viewport = useViewport()
  const phone = viewport.formFactor === 'phone'
  const coarse = viewport.coarse
  const tab = activeTab(state)
  const edit = uiStore.use((s) => s.bookmarkEdit)

  const [shownFolderId, setFolderId] = useState(() => {
    const requested = uiStore.get().overlayFolderId
    return requested && tree.get(requested)?.type === 'folder'
      ? requested
      : initialFolder(tree, state.platform)
  })
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ManagerSort>('manual')
  const [rawSelection, setSelection] = useState<ReadonlySet<string>>(() => new Set())
  const [rawAnchorId, setAnchorId] = useState<string | null>(null)
  const [rawFocusId, setFocusId] = useState<string | null>(null)
  const [rawRenamingId, setRenamingId] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  // The list's toolbar gets its hairline only while rows are scrolled under it (v2 §9.7).
  const [scrolled, setScrolled] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pointerDown = useRef<{ x: number; y: number } | null>(null)

  // Nodes deleted elsewhere (context menu, sync, another window) drop out of the view state;
  // a deleted shown folder falls back to the default root.
  const folderId =
    tree.get(shownFolderId)?.type === 'folder'
      ? shownFolderId
      : defaultBookmarkFolderId(state.platform)
  const selection = useMemo((): ReadonlySet<string> => {
    const live = [...rawSelection].filter((id) => tree.get(id))
    return live.length === rawSelection.size ? rawSelection : new Set(live)
  }, [rawSelection, tree])
  const focusId = rawFocusId && tree.get(rawFocusId) ? rawFocusId : null
  const anchorId = rawAnchorId && tree.get(rawAnchorId) ? rawAnchorId : null
  const renamingId = rawRenamingId && tree.get(rawRenamingId) ? rawRenamingId : null

  const searching = query.trim().length > 0
  const rows = useMemo(
    () =>
      searching
        ? searchBookmarks(tree, query, SEARCH_LIMIT)
        : sortManagerRows(tree.children(folderId), sort),
    [tree, folderId, query, sort, searching]
  )
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows])
  useFlip(listRef, rowIds.join('|'))

  const canReorder = !searching && sort === 'manual'
  const { drag, target, startDrag, ghostRef } = useBookmarkDrag({
    tree,
    canReorder,
    scrollRef: listRef
  })
  const dropFolderId =
    target && (target.position === 'into' || target.position === 'append') ? target.parentId : null

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  const clearSelection = useCallback((): void => {
    setSelection(new Set())
    setAnchorId(null)
  }, [])

  /** The selection in display order (moves and pastes keep the relative order). */
  const orderedSelection = useCallback(
    (): string[] => rowIds.filter((id) => selection.has(id)),
    [rowIds, selection]
  )

  const selectOnly = (id: string): void => {
    setSelection(new Set([id]))
    setAnchorId(id)
    setFocusId(id)
  }

  const toggleSelected = (id: string): void => {
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelection(next)
    setAnchorId(id)
    setFocusId(id)
    // Deselecting the last row on a phone leaves selection mode.
    if (!next.size) setSelectMode(false)
  }

  const selectRange = (id: string, additive: boolean): void => {
    const from = rowIds.indexOf(anchorId ?? focusId ?? id)
    const to = rowIds.indexOf(id)
    if (from === -1 || to === -1) {
      selectOnly(id)
      return
    }
    const [a, b] = from < to ? [from, to] : [to, from]
    const range = rowIds.slice(a, b + 1)
    setSelection((prev) => new Set(additive ? [...prev, ...range] : range))
    setFocusId(id)
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const navigate = useCallback(
    (id: string): void => {
      if (tree.get(id)?.type !== 'folder') return
      setFolderId(id)
      setQuery('')
      setRenamingId(null)
      setSelection(new Set())
      setAnchorId(null)
      setFocusId(null)
      setTreeOpen(false)
      listRef.current?.scrollTo({ top: 0 })
    },
    [tree]
  )
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])

  // "Bookmark all tabs" and the import land in a folder and ask the manager (already open or
  // not) to show it. The folder may reach the renderer a moment after the request does.
  useEffect(() => {
    let last = uiStore.get().overlayFolderId
    let pending: string | null = null
    const has = (id: string): boolean =>
      (browserStore.get().state?.bookmarks ?? []).some((n) => n.id === id && n.type === 'folder')
    const apply = (): void => {
      if (pending && has(pending)) {
        const id = pending
        pending = null
        navigateRef.current(id)
      }
    }
    const unsubscribeUi = uiStore.subscribe(() => {
      const id = uiStore.get().overlayFolderId
      if (id === last) return
      last = id
      pending = id
      apply()
    })
    const unsubscribeBrowser = browserStore.subscribe(apply)
    if (last && !has(last)) pending = last
    return () => {
      unsubscribeUi()
      unsubscribeBrowser()
    }
  }, [])

  const goUp = (): void => {
    const parent = tree.get(folderId)?.parentId
    if (parent) {
      const from = folderId
      navigate(parent)
      setFocusId(from)
      setSelection(new Set([from]))
      setAnchorId(from)
    }
  }

  const changeQuery = (value: string): void => {
    setQuery(value)
    setRenamingId(null)
    setSelection(new Set())
    setAnchorId(null)
    setFocusId(null)
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const open = (node: BookmarkNode, newTab: boolean): void => {
    if (node.type === 'folder') {
      navigate(node.id)
      return
    }
    run('bookmark.open', { id: node.id, newTab: newTab || !tab, tabId: tab?.id ?? null })
    if (!newTab) closeOverlay()
  }

  const openAll = (ids: string[]): void => {
    if (ids.length) run('bookmark.openAll', { ids })
  }

  const remove = (ids: string[]): void => {
    const doomed = ids.filter((id) => !isBookmarkRoot(id))
    if (!doomed.length) return
    // Keyboard focus lands on the next row that survives.
    const set = new Set(doomed)
    const at = focusId ? rowIds.indexOf(focusId) : -1
    const after = rowIds.slice(Math.max(at, 0)).find((id) => !set.has(id))
    const before = [...rowIds.slice(0, Math.max(at, 0))].reverse().find((id) => !set.has(id))
    const next = after ?? before ?? null
    run('bookmark.remove', { ids: doomed })
    setFocusId(next)
    setSelection(next ? new Set([next]) : new Set())
    setAnchorId(next)
  }

  const rename = (node: BookmarkNode): void => {
    if (isBookmarkRoot(node.id)) return
    if (node.type === 'folder') setRenamingId(node.id)
    else
      uiStore.set({
        bookmarkEdit: { id: node.id, parentId: node.parentId ?? folderId, type: 'url' }
      })
  }

  const renamed = (node: BookmarkNode, title: string): void => {
    setRenamingId(null)
    if (title && title !== node.title) run('bookmark.update', { id: node.id, title })
    listRef.current?.focus({ preventScroll: true })
  }

  const createFolder = useCallback(
    (parentId: string): void => {
      void cmd('bookmark.create', { parentId, title: 'New folder', type: 'folder' }).then(
        (node) => {
          if (!node) return
          if (parentId !== folderId || searching) navigate(parentId)
          setSelection(new Set([node.id]))
          setAnchorId(node.id)
          setFocusId(node.id)
          setRenamingId(node.id)
        }
      )
    },
    [folderId, searching, navigate]
  )

  const addBookmark = (): void =>
    uiStore.set({ bookmarkEdit: { id: null, parentId: folderId, type: 'url' } })

  const pasteIndex = (): number | undefined => {
    if (!canReorder || !focusId) return undefined
    const node = tree.get(focusId)
    return node && node.parentId === folderId ? node.index + 1 : undefined
  }

  const contextMenu = (e: React.MouseEvent, node: BookmarkNode | null): void => {
    e.preventDefault()
    e.stopPropagation()
    let ids: string[] = []
    if (node) {
      if (selection.has(node.id)) ids = orderedSelection()
      else {
        selectOnly(node.id)
        ids = [node.id]
      }
    }
    run('bookmark.contextMenu', { ids, folderId, x: e.clientX, y: e.clientY })
  }

  const importBookmarks = (): void => {
    void cmd('bookmark.import', undefined).then((result) => {
      if (result) navigate(result.folderId)
    })
  }

  // The context menu's "Rename" / "Add New Folder" arrive from the main process as edit requests;
  // URL edits are a dialog (rendered below), folder edits happen in place.
  const createFolderRef = useRef(createFolder)
  useEffect(() => {
    createFolderRef.current = createFolder
  }, [createFolder])
  useEffect(() => {
    const unsubscribe = uiStore.subscribe(() => {
      const request = uiStore.get().bookmarkEdit
      if (!request || request.type !== 'folder') return
      uiStore.set({ bookmarkEdit: null })
      if (request.id) setRenamingId(request.id)
      else createFolderRef.current(request.parentId)
    })
    return () => {
      unsubscribe()
      uiStore.set({ bookmarkEdit: null })
    }
  }, [])

  // Keyboard navigation starts in the list; the search takes over once you type.
  useEffect(() => {
    if (!coarse) listRef.current?.focus({ preventScroll: true })
  }, [coarse])

  // ---------------------------------------------------------------------------
  // Row events
  // ---------------------------------------------------------------------------

  const onRowPointerDown = (e: React.PointerEvent<HTMLDivElement>, node: BookmarkNode): void => {
    pointerDown.current = { x: e.clientX, y: e.clientY }
    if (e.pointerType !== 'mouse' || e.button !== 0 || renamingId === node.id) return
    if ((e.target as HTMLElement).closest('input')) return
    let ids: string[]
    if (selection.has(node.id)) ids = orderedSelection()
    else {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) selectOnly(node.id)
      ids = [node.id]
    }
    if (ids.some((id) => isBookmarkRoot(id))) return
    startDrag(e, topLevelSelection(tree, ids), e.currentTarget)
  }

  const movedSinceDown = (e: React.MouseEvent): boolean => {
    const down = pointerDown.current
    return Boolean(down && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= DRAG_THRESHOLD)
  }

  const onRowClick = (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode): void => {
    if (renamingId === node.id || movedSinceDown(e)) return
    if (coarse) {
      if (selectMode || selection.size) toggleSelected(node.id)
      else open(node, false)
      return
    }
    if (e.shiftKey) selectRange(node.id, e.ctrlKey || e.metaKey)
    else if (e.ctrlKey || e.metaKey) toggleSelected(node.id)
    else selectOnly(node.id)
  }

  const onRowDoubleClick = (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode): void => {
    if (coarse || renamingId === node.id) return
    if ((e.target as HTMLElement).closest('input')) return
    open(node, e.ctrlKey || e.metaKey)
  }

  const onRowAuxClick = (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode): void => {
    if (e.button !== 1) return
    e.preventDefault()
    if (node.type === 'url') run('bookmark.open', { id: node.id, newTab: true, tabId: null })
  }

  const onRowContextMenu = (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode): void => {
    if (renamingId === node.id) return
    // A long press on a phone selects (selection mode) and offers the menu for the selection.
    if (coarse && !selection.has(node.id)) {
      setSelectMode(true)
      toggleSelected(node.id)
      e.preventDefault()
      e.stopPropagation()
      run('bookmark.contextMenu', { ids: [node.id], folderId, x: e.clientX, y: e.clientY })
      return
    }
    contextMenu(e, node)
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (renamingId) return
    if ((e.target as HTMLElement).closest('input, textarea')) return
    const mod = e.ctrlKey || e.metaKey
    const at = focusId ? rowIds.indexOf(focusId) : -1
    const focusRow = (index: number): void => {
      const id = rowIds[Math.max(0, Math.min(rowIds.length - 1, index))]
      if (!id) return
      if (e.shiftKey) {
        setFocusId(id)
        selectRange(id, false)
      } else selectOnly(id)
      document.getElementById(`bm-row-${id}`)?.scrollIntoView({ block: 'nearest' })
    }
    const focused = focusId ? tree.get(focusId) : null
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusRow(at + 1)
        return
      case 'ArrowUp':
        e.preventDefault()
        focusRow(at < 0 ? 0 : at - 1)
        return
      case 'PageDown':
        e.preventDefault()
        focusRow(at + 10)
        return
      case 'PageUp':
        e.preventDefault()
        focusRow(at - 10)
        return
      case 'Home':
        e.preventDefault()
        focusRow(0)
        return
      case 'End':
        e.preventDefault()
        focusRow(rowIds.length - 1)
        return
      case 'ArrowRight':
        if (focused?.type === 'folder' && !searching) {
          e.preventDefault()
          navigate(focused.id)
        }
        return
      case 'ArrowLeft':
        if (!searching) {
          e.preventDefault()
          goUp()
        }
        return
      case 'Backspace':
        if (!searching) {
          e.preventDefault()
          goUp()
        }
        return
      case 'Enter': {
        e.preventDefault()
        const ids = orderedSelection()
        if (ids.length > 1) openAll(ids)
        else if (focused) open(focused, mod)
        return
      }
      case ' ':
        if (focused) {
          e.preventDefault()
          toggleSelected(focused.id)
        }
        return
      case 'Delete':
        e.preventDefault()
        remove(orderedSelection())
        return
      case 'F2':
        if (focused) {
          e.preventDefault()
          rename(focused)
        }
        return
      case 'Escape':
        if (selection.size) {
          e.preventDefault()
          e.stopPropagation()
          clearSelection()
        }
        return
      case '/':
        e.preventDefault()
        searchRef.current?.focus()
        return
      default:
        break
    }
    if (mod && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'a') {
        e.preventDefault()
        setSelection(new Set(rowIds))
        return
      }
      if (key === 'x' || key === 'c') {
        const ids = orderedSelection().filter((id) => !isBookmarkRoot(id))
        if (!ids.length) return
        e.preventDefault()
        run(key === 'x' ? 'bookmark.cut' : 'bookmark.copy', { ids })
        return
      }
      if (key === 'v') {
        e.preventDefault()
        run('bookmark.paste', { folderId, index: pasteIndex() })
        return
      }
      return
    }
    // Typing while the list has focus starts a search, like a file manager.
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault()
      changeQuery(query + e.key)
      searchRef.current?.focus()
    }
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && rowIds.length)) {
      e.preventDefault()
      const first = rowIds[0]
      if (first) selectOnly(first)
      listRef.current?.focus({ preventScroll: true })
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      changeQuery('')
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const current = tree.get(folderId)
  const lifted = new Set(drag && !drag.settling ? drag.ids : [])
  const search = (
    <div className={cn('relative', phone ? 'w-full' : 'w-[260px]')}>
      <input
        ref={searchRef}
        type="search"
        placeholder="Search bookmarks"
        aria-label="Search bookmarks"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => changeQuery(e.target.value)}
        onKeyDown={onSearchKeyDown}
        className={cn('zen-field text-[15px]', phone ? 'h-10' : 'h-8', query && 'pr-8')}
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[4px] opacity-60 hover:opacity-100"
          onClick={() => {
            changeQuery('')
            searchRef.current?.focus()
          }}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )

  const overflow = (
    <OverflowMenu
      sort={sort}
      onSort={setSort}
      onAddBookmark={addBookmark}
      onAddFolder={() => createFolder(folderId)}
      onImport={importBookmarks}
      onExport={() => run('bookmark.export', undefined)}
    />
  )

  const count = rows.length
  const summary = searching
    ? `${count === SEARCH_LIMIT ? `${count}+` : count} ${count === 1 ? 'result' : 'results'}`
    : `${count} ${count === 1 ? 'item' : 'items'}`

  return (
    <>
      <OverlayShell
        title="Bookmarks"
        variant="full"
        className="zen-bm-page"
        actions={
          <div className="flex items-center gap-1.5">
            {tab && !tab.url.startsWith('zen://') && (
              <button
                type="button"
                className="zen-toolbar-button h-7 w-7"
                title={tab.bookmarked ? 'Edit bookmark for this page' : 'Bookmark this page'}
                aria-label={tab.bookmarked ? 'Edit bookmark for this page' : 'Bookmark this page'}
                onClick={() => run('bookmark.star', { tabId: tab.id })}
              >
                <Star className="h-4 w-4" fill={tab.bookmarked ? 'currentColor' : 'none'} />
              </button>
            )}
            {overflow}
          </div>
        }
      >
        <div className={cn('flex h-full min-h-0', phone ? 'flex-col' : 'flex-row')}>
          {(!phone || treeOpen) && (
            <aside
              className={cn(
                'shrink-0 overflow-y-auto',
                phone ? 'max-h-[40%] px-2 pt-2' : 'w-[236px] p-2 pr-0'
              )}
            >
              <FolderTree
                tree={tree}
                currentId={searching ? '' : folderId}
                onOpen={navigate}
                onContextMenu={(id, e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  run('bookmark.contextMenu', {
                    ids: [id],
                    folderId: id,
                    x: e.clientX,
                    y: e.clientY
                  })
                }}
                dropFolderId={dropFolderId}
              />
            </aside>
          )}

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {phone && <div className="px-3 pt-3 pb-1">{search}</div>}
            {!phone && <div className="px-3 pt-2">{search}</div>}
            <div
              data-scrolled={scrolled || undefined}
              className={cn(
                'zen-bm-toolbar flex shrink-0 items-center gap-1.5 px-3',
                phone ? 'h-11' : 'h-10'
              )}
            >
              {phone && (
                <button
                  type="button"
                  className={cn(
                    'zen-toolbar-button h-8 w-8 shrink-0',
                    treeOpen && 'bg-[var(--zen-element-bg-active)]'
                  )}
                  aria-label="Folders"
                  aria-pressed={treeOpen}
                  onClick={() => setTreeOpen((v) => !v)}
                >
                  <FolderTreeIcon className="h-4 w-4" />
                </button>
              )}
              {searching ? (
                <span className="truncate text-[15px] font-semibold">
                  Results for “{query.trim()}”
                </span>
              ) : (
                <Breadcrumb
                  tree={tree}
                  folderId={folderId}
                  onOpen={navigate}
                  dropFolderId={dropFolderId}
                  className="min-w-0 flex-1"
                />
              )}
              <span className="zen-bm-dim ml-auto shrink-0 text-[13px] tabular-nums">
                {summary}
              </span>
              {coarse && !selectMode && count > 0 && (
                <button
                  type="button"
                  className="zen-toolbar-button h-8 w-8 shrink-0"
                  aria-label="Select items"
                  onClick={() => setSelectMode(true)}
                >
                  <ListChecks className="h-4 w-4" />
                </button>
              )}
            </div>

            <div
              ref={listRef}
              role="listbox"
              aria-multiselectable
              aria-label={searching ? 'Search results' : (current?.title ?? 'Bookmarks')}
              aria-activedescendant={focusId ? `bm-row-${focusId}` : undefined}
              tabIndex={0}
              data-bm-drop={searching ? undefined : `list:${folderId}`}
              data-target={target?.position === 'append' || undefined}
              className="zen-bm-list relative min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
              onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
              onKeyDown={onListKeyDown}
              onClick={(e) => {
                if (e.target === e.currentTarget) clearSelection()
              }}
              onContextMenu={(e) => {
                if (e.target === e.currentTarget) contextMenu(e, null)
              }}
            >
              {rows.length === 0 ? (
                <EmptyNote>
                  {searching
                    ? 'No matching bookmarks'
                    : current && isBookmarkRoot(current.id) && tree.size <= 3
                      ? 'Press Ctrl+D on any page to bookmark it'
                      : 'This folder is empty'}
                </EmptyNote>
              ) : (
                <div className="flex flex-col">
                  {rows.map((node) => (
                    <BookmarkRow
                      key={node.id}
                      node={node}
                      path={searching ? tree.pathLabel(node.id) || null : null}
                      childCount={node.type === 'folder' ? tree.children(node.id).length : 0}
                      selected={selection.has(node.id)}
                      focused={focusId === node.id && !coarse}
                      renaming={renamingId === node.id}
                      lifted={lifted.has(node.id)}
                      dropInto={target?.position === 'into' && target.rowId === node.id}
                      compact={coarse}
                      onPointerDown={onRowPointerDown}
                      onClick={onRowClick}
                      onDoubleClick={onRowDoubleClick}
                      onAuxClick={onRowAuxClick}
                      onContextMenu={onRowContextMenu}
                      onRenamed={renamed}
                    />
                  ))}
                </div>
              )}
              <DropIndicator target={target} container={listRef} />
            </div>

            {coarse && (selectMode || selection.size > 0) && (
              <SelectionBar
                count={selection.size}
                onOpenAll={() => openAll(orderedSelection())}
                onDelete={() => remove(orderedSelection())}
                onMore={(e) =>
                  run('bookmark.contextMenu', {
                    ids: orderedSelection(),
                    folderId,
                    x: e.clientX,
                    y: e.clientY
                  })
                }
                onDone={() => {
                  clearSelection()
                  setSelectMode(false)
                }}
              />
            )}
          </section>
        </div>
      </OverlayShell>

      {drag && (
        <ChromePortal>
          <DragGhost drag={drag} tree={tree} ghostRef={ghostRef} />
        </ChromePortal>
      )}
      {/* The manager's own edit dialog: over the page it is, in the frame's box, on its own host. */}
      <FrameDialogHost>
        {edit?.type === 'url' && (
          <EditBookmarkDialog key={edit.id ?? 'new'} state={state} edit={edit} />
        )}
      </FrameDialogHost>
    </>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** What travels under the pointer: the first picked row and how many came along. */
function DragGhost({
  drag,
  tree,
  ghostRef
}: {
  drag: BookmarkDrag
  tree: BookmarkTree
  ghostRef: RefObject<HTMLDivElement | null>
}): JSX.Element | null {
  const first = tree.get(drag.ids[0] ?? '')
  if (!first) return null
  // The hook moves this frame as if the whole row followed the pointer; what is drawn is a
  // compact copy beside the pointer (on the side with room), so the row under it – the drop
  // target and its outline – stays in view.
  const room = window.innerWidth - (drag.originX + drag.dx)
  const beside =
    room > GHOST_MAX_WIDTH + GHOST_GAP * 2
      ? { left: drag.dx + GHOST_GAP }
      : { right: drag.width - drag.dx + GHOST_GAP }
  return (
    <div
      ref={ghostRef}
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-[60] will-change-transform"
      style={{ width: drag.width }}
    >
      <div
        className="zen-bm-lift absolute flex h-8 items-center gap-2 rounded-[4px] px-2.5"
        style={{ ...beside, top: drag.dy - 16, maxWidth: GHOST_MAX_WIDTH }}
      >
        <BookmarkIcon node={first} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{nodeLabel(first)}</span>
        {drag.ids.length > 1 && (
          <span className="rounded-full bg-[var(--v2-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--v2-on-accent)] tabular-nums">
            {drag.ids.length}
          </span>
        )}
      </div>
    </div>
  )
}

/** Phone selection mode: the actions for the picked rows. */
function SelectionBar({
  count,
  onOpenAll,
  onDelete,
  onMore,
  onDone
}: {
  count: number
  onOpenAll: () => void
  onDelete: () => void
  onMore: (e: React.MouseEvent) => void
  onDone: () => void
}): JSX.Element {
  return (
    <div className="zen-animate-in flex h-12 shrink-0 items-center gap-1 px-3 shadow-[0_-1px_0_var(--zen-border)]">
      <span className="flex-1 text-[13px] font-medium">
        {count ? `${count} selected` : 'Tap items to select'}
      </span>
      <button
        type="button"
        className="zen-toolbar-button h-9 w-9"
        aria-label="Open all"
        disabled={!count}
        onClick={onOpenAll}
      >
        <ExternalLink className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-9 w-9"
        aria-label="Delete"
        disabled={!count}
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-9 w-9"
        aria-label="More"
        disabled={!count}
        onClick={onMore}
      >
        <Ellipsis className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-9 w-9"
        aria-label="Done"
        onClick={onDone}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

interface OverflowProps {
  sort: ManagerSort
  onSort: (sort: ManagerSort) => void
  onAddBookmark: () => void
  onAddFolder: () => void
  onImport: () => void
  onExport: () => void
}

/** The manager's own menu: new items, the view's sort order, import and export. */
function OverflowMenu({
  sort,
  onSort,
  onAddBookmark,
  onAddFolder,
  onImport,
  onExport
}: OverflowProps): JSX.Element {
  // Open, and whether the keyboard opened it: then the first item takes focus; a pointer leaves
  // focus on the menu itself so the arrows start from the top (v2 draft §9.22).
  const [open, setOpen] = useState<'keyboard' | 'pointer' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    setOpen(null)
    buttonRef.current?.focus()
  }
  useEscapeTrap(open !== null, close)

  useEffect(() => {
    if (!open) return
    const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]')
    const first = menu?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')
    if (open === 'keyboard') first?.focus()
    else menu?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  const item = (
    label: string,
    icon: ReactNode,
    onSelect: () => void,
    checked?: boolean
  ): JSX.Element => (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className="zen-bm-menu-row"
      onClick={() => {
        close()
        onSelect()
      }}
    >
      <span className="flex h-4 w-4 items-center justify-center opacity-70">{icon}</span>
      <span className="flex-1">{label}</span>
      {checked && <Check className="h-4 w-4" />}
    </button>
  )

  // Arrow keys walk the rows (from the top when the menu itself has focus) and Tab wraps through
  // them; Escape is trapped above so it closes the menu, not the manager.
  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const back = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)
    const next =
      at === -1 ? (back ? rows.length - 1 : 0) : (at + (back ? -1 : 1) + rows.length) % rows.length
    rows[next]?.focus()
    e.preventDefault()
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={cn('zen-toolbar-button h-7 w-7', open && 'bg-[var(--zen-element-bg-active)]')}
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        // A click's `detail` is its count; Enter and Space report 0.
        onClick={(e) => setOpen((v) => (v ? null : e.detail === 0 ? 'keyboard' : 'pointer'))}
      >
        <Ellipsis className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          tabIndex={-1}
          className="zen-bm-menu zen-animate-pop absolute top-[calc(100%+6px)] right-0 z-20 outline-none"
          onKeyDown={onMenuKeyDown}
        >
          {item('Add New Bookmark…', <Plus className="h-4 w-4" />, onAddBookmark)}
          {item('Add New Folder', <FolderPlus className="h-4 w-4" />, onAddFolder)}
          <div className="zen-bm-menu-sep" />
          <div className="zen-bm-menu-heading">Sort by</div>
          {item(
            'Manual Order',
            <ListChecks className="h-4 w-4" />,
            () => onSort('manual'),
            sort === 'manual'
          )}
          {item('Name', <ArrowDownAZ className="h-4 w-4" />, () => onSort('name'), sort === 'name')}
          {item('URL', <Link className="h-4 w-4" />, () => onSort('url'), sort === 'url')}
          {item(
            'Date Added',
            <Clock className="h-4 w-4" />,
            () => onSort('dateAdded'),
            sort === 'dateAdded'
          )}
          <div className="zen-bm-menu-sep" />
          {item('Import Bookmarks…', <Upload className="h-4 w-4" />, onImport)}
          {item('Export Bookmarks…', <Download className="h-4 w-4" />, onExport)}
        </div>
      )}
    </div>
  )
}
