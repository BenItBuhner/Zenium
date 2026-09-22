import type { JSX, KeyboardEvent, MouseEvent, PointerEvent, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownAZ,
  Check,
  Clock,
  Download,
  Ellipsis,
  ExternalLink,
  Link,
  ListChecks,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { BookmarkNode, Platform, Tab, UIState } from '@shared/types'
import { parseInternalPageUrl } from '@shared/internalPages'
import {
  BOOKMARKS_BAR_ID,
  type BookmarkTree,
  defaultBookmarkFolderId,
  isBookmarkRoot,
  searchBookmarks,
  topLevelSelection
} from '@shared/bookmarks'
import { type ManagerSort, sortManagerRows } from '@shared/bookmarkViews'
import { shortcutHint } from '@shared/shortcuts'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { cmd, run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { useViewport } from '@renderer/lib/formFactor'
import { contextMenuAnchor, handleMenuKey } from '@renderer/lib/menuKeys'
import { ChromePortal } from '@renderer/lib/portals'
import { closeBookmarkChrome, openBookmarkChrome, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BookmarkIcon } from '../../bookmarks/BookmarkIcon'
import { useEscapeTrap } from '../../bookmarks/escape'
import { nodeLabel, useBookmarkTree } from '../../bookmarks/tree'
import {
  PageEmpty,
  PageGroup,
  PageSearchField,
  PageTitleBlock,
  TWO_PANE_MIN_WIDTH
} from '../PageFrame'
import { usePageSearch } from '../usePageSearch'
import { BookmarkRow } from './BookmarkRow'
import { Breadcrumb } from './Breadcrumb'
import { DropIndicator } from './DropIndicator'
import { FolderTree } from './FolderTree'
import { type BookmarkDrag, useBookmarkDrag } from './useBookmarkDrag'
import { useFlip } from './useFlip'

const SEARCH_LIMIT = 200
const DRAG_THRESHOLD = 5
/** The drag ghost: a compact copy of the row, drawn a little to the side of the pointer. */
const GHOST_MAX_WIDTH = 320
const GHOST_GAP = 14
const LIST_HEADING_ID = 'zen-bm-list-heading'

/**
 * The folder the manager opens on when its URL names none: the bookmarks bar (Chrome) on the
 * desktop, the platform's own root elsewhere; when that one is empty, the first root with
 * anything in it.
 */
function initialFolder(tree: BookmarkTree, platform: Platform): string {
  const preferred = platform === 'android' ? defaultBookmarkFolderId(platform) : BOOKMARKS_BAR_ID
  if (tree.children(preferred).length) return preferred
  return tree.roots().find((r) => tree.children(r.id).length)?.id ?? preferred
}

/**
 * The bookmarks manager (`zen://bookmarks`, Ctrl+Shift+O; Chrome's `chrome://bookmarks`): a
 * chrome page tab on the shared page frame (design language v2 §10.1, `pages/PageFrame.tsx`),
 * two panes where they fit (§10.5, `TWO_PANE_MIN_WIDTH`). The header – the 22/600 title block
 * "Bookmarks" with Add bookmark, Add folder and the page's ⋮ (sort order, import, export) in
 * its trailing slot, the §9.12 search field under it – stays put over both panes and draws
 * §9.7's hairline once either pane has scrolled under it. The left pane is the folder tree
 * (`FolderTree`, the Settings nav's 234 column of 34 px rows); the right the shown folder's
 * items as §9.21 two-line rows (`BookmarkRow`) under the folder's path as the group's heading
 * (`Breadcrumb`, its last segment the `h2`) with the count aside, or every folder's matches
 * under "Results for …" while searching. Narrower than two panes the tree column goes and the
 * breadcrumb is the way up.
 *
 * The tab's URL is the page's state: `?folder=<id>` is the shown folder – every way of opening a
 * folder (the tree, the breadcrumb, a folder row, Right and Left, a "Bookmark Manager" entry
 * on a folder, the import's "Show in manager") is a `page.navigate` with a history entry, so
 * back returns to the folder before, as Chrome's manager does – and `?q=<text>` the search
 * (`usePageSearch`: replaced, not pushed), so a restored tab comes back where it was.
 *
 * Chrome's manager otherwise: search across the whole tree, drag and drop with §9.4's caret and
 * outlines (`useBookmarkDrag`), the manual order and the sorts, multi-select (click, Shift for
 * a run, Ctrl+A, Ctrl+arrow to move the focus alone and Space to toggle the focused row; the
 * selected on `--v2-selected`, §9.6), the row and empty-space context menus, the row's ⋮, cut /
 * copy / paste, F2 and the inline rename (§9.12), Delete, Enter and double-click to open
 * (Ctrl+Enter for a new tab), and the keyboard model of a file list. Ctrl-click is not the
 * selection's here as it is in Chrome's manager: on every page row it means one thing (§10.1
 * as amended) – open it behind this tab, as a middle click does – and picks nothing. The Edit
 * dialog
 * (#271) is the frame's (`TabDialogs`): a URL edit asked for here opens it over this page; a
 * folder rename asked for by the menus is done in place when the folder is in view.
 */
export function BookmarkManager({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const tree = useBookmarkTree(state)
  const { width: windowWidth, coarse } = useViewport()
  const root = useRef<HTMLDivElement>(null)
  const measured = useElementWidth(root)
  const twoPane = (measured || windowWidth) >= TWO_PANE_MIN_WIDTH
  const starChord = shortcutHint(state.shortcuts, 'bookmark.add', state.platform)

  const ref = parseInternalPageUrl(tab.url)
  const urlFolder = ref?.query?.folder ?? ''
  const urlQuery = ref?.query?.q ?? ''
  // The URL's folder, when it names one that exists; the default one otherwise (a deleted
  // shown folder – the menus, sync, another window – falls back the same way).
  const folderId =
    urlFolder && tree.get(urlFolder)?.type === 'folder'
      ? urlFolder
      : initialFolder(tree, state.platform)

  const [sort, setSort] = useState<ManagerSort>('manual')
  const [rawSelection, setSelection] = useState<ReadonlySet<string>>(() => new Set())
  const [rawAnchorId, setAnchorId] = useState<string | null>(null)
  const [rawFocusId, setFocusId] = useState<string | null>(null)
  const [rawRenamingId, setRenamingId] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [scrolled, setScrolled] = useState({ tree: false, list: false })
  const listRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pointerDown = useRef<{ x: number; y: number } | null>(null)

  const clearSelection = useCallback((): void => {
    setSelection(new Set())
    setAnchorId(null)
  }, [])

  // The search and the URL, kept as one (`usePageSearch`); a new search – typed or brought by
  // the URL – starts over with nothing picked. The folder rides along in the URL.
  const { query, setQuery, text } = usePageSearch({
    urlQuery,
    push: (value) =>
      run('page.navigate', {
        tabId: tab.id,
        section: null,
        replace: true,
        query: pageQuery(urlFolder, value)
      }),
    onAdopt: () => {
      clearSelection()
      setFocusId(null)
      setRenamingId(null)
    }
  })
  const searching = text.length > 0

  // Nodes deleted elsewhere drop out of the view state.
  const selection = useMemo((): ReadonlySet<string> => {
    const live = [...rawSelection].filter((id) => tree.get(id))
    return live.length === rawSelection.size ? rawSelection : new Set(live)
  }, [rawSelection, tree])
  const focusId = rawFocusId && tree.get(rawFocusId) ? rawFocusId : null
  const anchorId = rawAnchorId && tree.get(rawAnchorId) ? rawAnchorId : null
  const renamingId = rawRenamingId && tree.get(rawRenamingId) ? rawRenamingId : null

  const rows = useMemo(
    () =>
      searching
        ? searchBookmarks(tree, text, SEARCH_LIMIT)
        : sortManagerRows(tree.children(folderId), sort),
    [tree, folderId, text, sort, searching]
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
    // Deselecting the last row on a touch screen leaves selection mode.
    if (!next.size) setSelectMode(false)
  }

  /** Shift-click or Shift+arrow: the run from the anchor to this row is the selection. */
  const selectRange = (id: string): void => {
    const from = rowIds.indexOf(anchorId ?? focusId ?? id)
    const to = rowIds.indexOf(id)
    if (from === -1 || to === -1) {
      selectOnly(id)
      return
    }
    const [a, b] = from < to ? [from, to] : [to, from]
    setSelection(new Set(rowIds.slice(a, b + 1)))
    setFocusId(id)
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Show a folder: the URL moves (a history entry), and the list starts over. */
  const navigate = useCallback(
    (id: string): void => {
      if (tree.get(id)?.type !== 'folder') return
      setRenamingId(null)
      setSelection(new Set())
      setAnchorId(null)
      setFocusId(null)
      setSelectMode(false)
      run('page.navigate', {
        tabId: tab.id,
        section: null,
        replace: false,
        query: pageQuery(id, '')
      })
    },
    [tree, tab.id]
  )

  // A folder change (ours, back, forward, a link) scrolls the list to its top.
  const lastFolder = useRef(folderId)
  useEffect(() => {
    if (lastFolder.current === folderId) return
    lastFolder.current = folderId
    listRef.current?.scrollTo({ top: 0 })
  }, [folderId])

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
    if (!value.trim()) return
    setSelection(new Set())
    setAnchorId(null)
    setFocusId(null)
  }

  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    searchRef.current?.focus()
    searchRef.current?.select()
    return true
  })

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const open = (node: BookmarkNode, newTab: boolean): void => {
    if (node.type === 'folder') {
      navigate(node.id)
      return
    }
    run('bookmark.open', { id: node.id, newTab, tabId: tab.id })
  }

  /** A middle or Ctrl click on a bookmark's row: a new tab behind this one (§10.1). */
  const openBehind = (node: BookmarkNode): void => {
    run('bookmark.open', { id: node.id, newTab: true, tabId: tab.id, background: true })
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

  /** Rename: a folder in place; a bookmark in the frame's Edit dialog (#271). */
  const rename = (node: BookmarkNode): void => {
    if (isBookmarkRoot(node.id)) return
    if (node.type === 'folder') setRenamingId(node.id)
    else
      void openBookmarkChrome(
        { bookmarkEdit: { id: node.id, parentId: node.parentId ?? folderId, type: 'url' } },
        tab.id
      )
  }

  const renamed = (node: BookmarkNode, title: string): void => {
    setRenamingId(null)
    if (title && title !== node.title) run('bookmark.update', { id: node.id, title })
    rowsRef.current?.focus({ preventScroll: true })
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
    void openBookmarkChrome({ bookmarkEdit: { id: null, parentId: folderId, type: 'url' } }, tab.id)

  const pasteIndex = (): number | undefined => {
    if (!canReorder || !focusId) return undefined
    const node = tree.get(focusId)
    return node && node.parentId === folderId ? node.index + 1 : undefined
  }

  const contextMenu = (e: MouseEvent, node: BookmarkNode | null): void => {
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
    run('bookmark.contextMenu', { ids, folderId, ...contextMenuAnchor(e) })
  }

  /** The row's ⋮ and the Menu key: the row's menu hung from the button, or from the row. */
  const rowMenu = (node: BookmarkNode, anchor: Element, keyboard: boolean): void => {
    const ids = selection.has(node.id) ? orderedSelection() : [node.id]
    if (!selection.has(node.id)) selectOnly(node.id)
    const box = anchor.getBoundingClientRect()
    run('bookmark.contextMenu', {
      ids,
      folderId,
      x: Math.round(box.right),
      y: Math.round(box.bottom),
      keyboard
    })
  }

  const importBookmarks = (): void => {
    void cmd('bookmark.import', undefined).then((result) => {
      if (result) navigate(result.folderId)
    })
  }

  // The menus' "Rename…" on a folder and "Add New Folder" arrive from the main process as edit
  // requests (`bookmark.edit`, set on the store by `openBookmarkChrome`): a new folder is made
  // and named in place, a folder in view is renamed in place; anything else – a bookmark, a
  // folder the list does not show (the bar's, while this page is up) – is the frame's dialog.
  useEffect(() => {
    const unsubscribe = uiStore.subscribe(() => {
      const request = uiStore.get().bookmarkEdit
      if (!request || request.type !== 'folder') return
      if (request.id && !rowIds.includes(request.id)) return
      closeBookmarkChrome({ bookmarkEdit: null }, { keepFocus: true })
      if (request.id) setRenamingId(request.id)
      else createFolder(request.parentId)
    })
    return unsubscribe
  }, [rowIds, createFolder])

  // Keyboard navigation starts in the list; the search takes over once you type.
  useEffect(() => {
    if (!coarse && !urlQuery) rowsRef.current?.focus({ preventScroll: true })
    // Only on mount: a later search or folder must not pull the focus from the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Row events
  // ---------------------------------------------------------------------------

  const onRowPointerDown = (e: PointerEvent<HTMLLIElement>, node: BookmarkNode): void => {
    pointerDown.current = { x: e.clientX, y: e.clientY }
    if (e.pointerType !== 'mouse' || e.button !== 0 || renamingId === node.id) return
    if ((e.target as HTMLElement).closest('input, button')) return
    let ids: string[]
    if (selection.has(node.id)) ids = orderedSelection()
    else {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) selectOnly(node.id)
      ids = [node.id]
    }
    if (ids.some((id) => isBookmarkRoot(id))) return
    startDrag(e, topLevelSelection(tree, ids), e.currentTarget)
  }

  const movedSinceDown = (e: MouseEvent): boolean => {
    const down = pointerDown.current
    return Boolean(down && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= DRAG_THRESHOLD)
  }

  const onRowClick = (e: MouseEvent<HTMLLIElement>, node: BookmarkNode): void => {
    if (renamingId === node.id || movedSinceDown(e)) return
    if ((e.target as HTMLElement).closest('input, button')) return
    if (coarse) {
      if (selectMode || selection.size) toggleSelected(node.id)
      else open(node, false)
      return
    }
    if (e.shiftKey) selectRange(node.id)
    else if (e.ctrlKey || e.metaKey) {
      // §10.1's one meaning on every page row: Ctrl-click opens the bookmark behind this tab
      // and picks nothing – the selection stays as it was. A Ctrl-double-click's second click
      // (`detail` 2) opens nothing more; a folder, which cannot open behind, is selected as a
      // plain click selects it.
      if (e.detail > 1) return
      if (node.type === 'url') openBehind(node)
      else selectOnly(node.id)
    } else selectOnly(node.id)
  }

  const onRowDoubleClick = (e: MouseEvent<HTMLLIElement>, node: BookmarkNode): void => {
    if (coarse || renamingId === node.id) return
    if ((e.target as HTMLElement).closest('input, button')) return
    // A Ctrl-double-click's first click opened the bookmark behind already.
    if (e.ctrlKey || e.metaKey) return
    open(node, false)
  }

  const onRowAuxClick = (e: MouseEvent<HTMLLIElement>, node: BookmarkNode): void => {
    if (e.button !== 1) return
    e.preventDefault()
    if (node.type === 'url') openBehind(node)
  }

  const onRowContextMenu = (e: MouseEvent<HTMLLIElement>, node: BookmarkNode): void => {
    if (renamingId === node.id) return
    // A long press on a touch screen selects (selection mode) and offers the menu for the row.
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

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (renamingId) return
    if ((e.target as HTMLElement).closest('input, textarea')) return
    const mod = e.ctrlKey || e.metaKey
    const at = focusId ? rowIds.indexOf(focusId) : -1
    // An arrow selects the row it lands on; with Shift the run from the anchor; with Ctrl it
    // moves the focus alone, the selection untouched, so Space can then add a row that is not
    // the run's – the file list's way to a discontiguous pick now that Ctrl-click is not it.
    const focusRow = (index: number): void => {
      const id = rowIds[Math.max(0, Math.min(rowIds.length - 1, index))]
      if (!id) return
      if (e.shiftKey) {
        setFocusId(id)
        selectRange(id)
      } else if (mod) setFocusId(id)
      else selectOnly(id)
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
      case 'ContextMenu':
        if (focused) {
          e.preventDefault()
          const row = document.getElementById(`bm-row-${focused.id}`)
          if (row) rowMenu(focused, row, true)
        }
        return
      case 'F10':
        if (e.shiftKey && focused) {
          e.preventDefault()
          const row = document.getElementById(`bm-row-${focused.id}`)
          if (row) rowMenu(focused, row, true)
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

  const onSearchKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!(e.target as HTMLElement).matches('input')) return
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && rowIds.length)) {
      e.preventDefault()
      const first = rowIds[0]
      if (first) selectOnly(first)
      rowsRef.current?.focus({ preventScroll: true })
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const current = tree.get(folderId)
  const lifted = new Set(drag && !drag.settling ? drag.ids : [])
  const count = rows.length
  const summary = searching
    ? `${count === SEARCH_LIMIT ? `${count}+` : count} ${count === 1 ? 'result' : 'results'}`
    : `${count} ${count === 1 ? 'item' : 'items'}`
  const selecting = coarse && (selectMode || selection.size > 0)

  const actions = selecting ? (
    <>
      <span className="zen-page-title-count" aria-live="polite">
        {selection.size ? `${selection.size} selected` : 'Tap items to select'}
      </span>
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label="Open all"
        disabled={!selection.size}
        onClick={() => openAll(orderedSelection())}
      >
        <ExternalLink aria-hidden />
      </button>
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label="Delete"
        disabled={!selection.size}
        onClick={() => remove(orderedSelection())}
      >
        <Trash2 aria-hidden />
      </button>
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label="More"
        aria-haspopup="menu"
        disabled={!selection.size}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          run('bookmark.contextMenu', {
            ids: orderedSelection(),
            folderId,
            x: Math.round(box.right),
            y: Math.round(box.bottom),
            keyboard: e.detail === 0
          })
        }}
      >
        <Ellipsis aria-hidden />
      </button>
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label="Done"
        onClick={() => {
          clearSelection()
          setSelectMode(false)
        }}
      >
        <X aria-hidden />
      </button>
    </>
  ) : (
    <>
      <button type="button" className="zen-v2-button" onClick={addBookmark}>
        Add bookmark
      </button>
      <button type="button" className="zen-v2-button" onClick={() => createFolder(folderId)}>
        Add folder
      </button>
      <OverflowMenu
        sort={sort}
        onSort={setSort}
        onImport={importBookmarks}
        onExport={() => run('bookmark.export', undefined)}
      />
    </>
  )

  const heading = searching ? (
    <h2 id={LIST_HEADING_ID} className="zen-page-heading-text">
      Results for “{text}”
    </h2>
  ) : (
    <Breadcrumb
      tree={tree}
      folderId={folderId}
      onOpen={navigate}
      dropFolderId={dropFolderId}
      headingId={LIST_HEADING_ID}
    />
  )

  return (
    <div
      ref={root}
      className="zen-page zen-bm-page"
      data-testid="bookmarks-manager"
      data-layout={twoPane ? 'two-pane' : 'one-pane'}
      data-folder={searching ? undefined : folderId}
    >
      <header
        className="zen-page-header zen-bm-header"
        data-scrolled={scrolled.list || scrolled.tree || undefined}
        onKeyDown={onSearchKeyDown}
      >
        <PageTitleBlock title="Bookmarks" actions={actions} />
        <PageSearchField
          value={query}
          onChange={changeQuery}
          placeholder="Search bookmarks"
          field={searchRef}
          testId="bookmarks-search"
        />
      </header>
      <div className="zen-bm-panes">
        {twoPane && (
          <nav
            className="zen-bm-nav"
            aria-label="Folders"
            onScroll={(e) => {
              const top = e.currentTarget.scrollTop > 0
              setScrolled((s) => (s.tree === top ? s : { ...s, tree: top }))
            }}
          >
            <FolderTree
              tree={tree}
              currentId={searching ? '' : folderId}
              onOpen={navigate}
              onContextMenu={(id, e) => {
                e.preventDefault()
                e.stopPropagation()
                run('bookmark.contextMenu', { ids: [id], folderId: id, ...contextMenuAnchor(e) })
              }}
              dropFolderId={dropFolderId}
            />
          </nav>
        )}
        <div
          ref={listRef}
          className="zen-bm-list"
          data-bm-drop={searching ? undefined : `list:${folderId}`}
          data-target={target?.position === 'append' || undefined}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop > 0
            setScrolled((s) => (s.list === top ? s : { ...s, list: top }))
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) clearSelection()
          }}
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) contextMenu(e, null)
          }}
        >
          <div className="zen-page-body">
            <PageGroup
              headingElement={heading}
              headingId={LIST_HEADING_ID}
              aside={summary}
              control={
                coarse && !selectMode && count > 0 ? (
                  <button
                    type="button"
                    className="zen-v2-icon-button"
                    aria-label="Select items"
                    onClick={() => setSelectMode(true)}
                  >
                    <ListChecks aria-hidden />
                  </button>
                ) : undefined
              }
              data-testid="bookmarks-list"
            >
              {rows.length === 0 ? (
                <PageEmpty testId="bookmarks-empty">
                  {searching
                    ? 'No matching bookmarks'
                    : current && isBookmarkRoot(current.id) && tree.size <= 3
                      ? starChord
                        ? `Press ${starChord} on any page to bookmark it`
                        : 'Bookmark any page from the star in the address bar'
                      : 'This folder is empty'}
                </PageEmpty>
              ) : (
                <ul
                  ref={rowsRef}
                  role="listbox"
                  aria-multiselectable
                  aria-labelledby={LIST_HEADING_ID}
                  aria-activedescendant={focusId ? `bm-row-${focusId}` : undefined}
                  tabIndex={0}
                  className="zen-page-rows zen-bm-rows"
                  onKeyDown={onListKeyDown}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) clearSelection()
                  }}
                  onContextMenu={(e) => {
                    if (e.target === e.currentTarget) contextMenu(e, null)
                  }}
                >
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
                      onPointerDown={onRowPointerDown}
                      onClick={onRowClick}
                      onDoubleClick={onRowDoubleClick}
                      onAuxClick={onRowAuxClick}
                      onContextMenu={onRowContextMenu}
                      onMenu={(e, n) => rowMenu(n, e.currentTarget, e.detail === 0)}
                      onRenamed={renamed}
                    />
                  ))}
                </ul>
              )}
            </PageGroup>
          </div>
          <DropIndicator target={target} container={listRef} />
        </div>
      </div>

      {drag && (
        <ChromePortal>
          <DragGhost drag={drag} tree={tree} ghostRef={ghostRef} />
        </ChromePortal>
      )}
    </div>
  )
}

/** The page's URL query: the folder first, the search after it – one order, one URL per state. */
function pageQuery(folder: string, q: string): Record<string, string> | undefined {
  const query: Record<string, string> = {}
  if (folder) query.folder = folder
  if (q) query.q = q
  return Object.keys(query).length ? query : undefined
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** What travels under the pointer: the first picked row and how many came along (§9.4). */
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
        className="zen-bm-lift zen-bm-drag-ghost"
        style={{ ...beside, top: drag.dy - 16, maxWidth: GHOST_MAX_WIDTH }}
      >
        <BookmarkIcon node={first} className="zen-bm-drag-ghost-icon" />
        <span className="zen-bm-drag-ghost-label">{nodeLabel(first)}</span>
        {drag.ids.length > 1 && (
          <span className="zen-v2-badge zen-bm-drag-ghost-count">{drag.ids.length}</span>
        )}
      </div>
    </div>
  )
}

interface OverflowProps {
  sort: ManagerSort
  onSort: (sort: ManagerSort) => void
  onImport: () => void
  onExport: () => void
}

/** The page's own menu (§9.3 icon button, §9.20 menu): the view's sort order, import and export. */
function OverflowMenu({ sort, onSort, onImport, onExport }: OverflowProps): JSX.Element {
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
    const onDown = (e: globalThis.MouseEvent): void => {
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

  // Arrow keys walk the rows (from the top when the menu itself has focus), Home and End jump,
  // Tab wraps through them and a letter goes to or runs the row it names (lib/menuKeys.ts);
  // Escape is trapped above so it closes the menu and nothing else.
  const onMenuKeyDown = (e: KeyboardEvent): void => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    handleMenuKey(e, rows, { mnemonics: true, tab: true })
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={cn('zen-v2-icon-button', open && 'zen-bm-menu-open')}
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        // A click's `detail` is its count; Enter and Space report 0.
        onClick={(e) => setOpen((v) => (v ? null : e.detail === 0 ? 'keyboard' : 'pointer'))}
      >
        <Ellipsis aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          tabIndex={-1}
          className="zen-bm-menu zen-animate-pop absolute top-[calc(100%+6px)] right-0 z-20 outline-none"
          onKeyDown={onMenuKeyDown}
        >
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
