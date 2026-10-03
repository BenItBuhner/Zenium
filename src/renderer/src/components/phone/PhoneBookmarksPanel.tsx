import type { JSX, MouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  EllipsisVertical,
  Folder,
  Globe,
  ListFilter,
  Trash2
} from 'lucide-react'
import { S } from '@shared/strings'
import type { BookmarkNode, UIState } from '@shared/types'
import { isBookmarkRoot, searchBookmarks } from '@shared/bookmarks'
import { sortBookmarkRows, type BookmarkRowDisplay } from '@shared/bookmarkRows'
import { displayUrl } from '@shared/url'
import { announce } from '@renderer/lib/announce'
import { run } from '@renderer/lib/api'
import { editBookmark } from '@renderer/lib/bookmarkEdit'
import {
  DISPLAY_ANNOUNCEMENTS,
  pictureTabFor,
  SORT_ORDER_ANNOUNCEMENTS,
  SORT_VIEW_MENU_TITLE,
  sortViewMenuItems
} from '@renderer/lib/bookmarkRowOptions'
import {
  deletableIds,
  folderCountLabel,
  folderRows,
  folderTitle,
  initialFolderStack,
  pruneFolderStack,
  type FolderId
} from '@renderer/lib/bookmarkList'
import {
  NO_SELECTION,
  orderedSelection,
  pruneSelection,
  startSelection,
  toggleSelected,
  type Selection
} from '@renderer/lib/multiSelect'
import { openInPrivateItems } from '@renderer/lib/privateTabs'
import { activeTab } from '@renderer/lib/selectors'
import { useThumbnail } from '@renderer/lib/thumbnails'
import {
  browserStore,
  closeOverlay,
  MENU_GAP,
  showLocalMenu,
  uiStore,
  type LocalMenuItem
} from '@renderer/lib/ui'
import { OverlayShell } from '../overlays/OverlayShell'
import { BookmarkMoveSheet } from './BookmarkMoveSheet'
import { useFlip } from './useFlip'
import {
  PhoneEmptyNote,
  PhoneHeader,
  PhoneIconButton,
  PhoneListRow,
  PhoneSearchField,
  PhoneSelectionHeader,
  RowFavicon
} from './PhoneList'
import {
  noteSheetOpener,
  removeWithUndo,
  useBookmarkTree,
  usePanelStep,
  usePendingDeletes,
  useScrolled
} from './phonePanel'

const SEARCH_LIMIT = 200

/**
 * Bookmarks on a phone (design-language v2 draft, sections 5, 6 and 9): one folder at a time under a 56
 * header – folders as rows that push in, bookmarks as rows with favicon, title and address and
 * a trailing menu (Chrome 152's row menu as far as the model reaches, HB-12: select, edit, move
 * to a folder, open in a new or a private tab, copy the link, delete) – with a search field over
 * the whole tree. A long press, or the menu's Select, starts selection mode, whose header
 * replaces the panel's (Chrome's selection toolbar, HB-15: Delete and More – Edit for exactly
 * one row, Move to…, the open rows, Copy link); the back gesture leaves it, then climbs out of
 * folders, then closes the panel. Deletes are undoable from their toast. The editor is the
 * `BookmarkEditSheet` that `TabDialogs` mounts in the frame's dialog host on a phone; Move to…
 * is the panel's own `BookmarkMoveSheet` in the same host; the row menus are the shared menu
 * sheet. Chrome's manager has no "Add to reading list" row (its reading list is a bookmark
 * folder reached by Move to…), so none is built here.
 *
 * The header's "Sort and view options" (HB-13; Chrome's `sort_submenu`) hangs Chrome's six
 * orders and two views as radio rows (`lib/bookmarkRowOptions.ts`). The order applies to a
 * folder's rows and to search results alike (`sortBookmarkRows`); the view draws each row as
 * an image tile (Visual: the card picture of an open tab on the page, else the favicon on a
 * card) or as the plain favicon row (Compact). Both are the device's own settings, as Chrome's
 * `BookmarkUiPrefs` are (`DEVICE_LOCAL_SETTINGS`). A re-order glides the rows to their new
 * places on the house spring (`useFlip`, v2 §11.4 – Chrome keeps only its RecyclerView's move
 * animations); a folder, a search or a view change is a cut.
 */
export function PhoneBookmarksPanel({ state }: { state: UIState }): JSX.Element {
  const tree = useBookmarkTree(state)
  const { platform } = state
  const tab = activeTab(state)
  const sortOrder = state.settings.bookmarkRowSortOrder
  const display = state.settings.bookmarkRowDisplay
  const [rawStack, setStack] = useState<readonly FolderId[]>(() =>
    initialFolderStack(tree, platform, uiStore.get().overlayFolderId)
  )
  const [query, setQuery] = useState('')
  const [rawSelection, setSelection] = useState<Selection>(NO_SELECTION)
  /** The rows Move to… is picking a folder for, while its sheet stands. */
  const [moving, setMoving] = useState<readonly string[] | null>(null)
  const pending = usePendingDeletes()
  const [attachList, listScrolled] = useScrolled<HTMLDivElement>()
  const listRef = useRef<HTMLDivElement | null>(null)

  // A folder deleted elsewhere (sync, another window) unwinds the stack to what still exists.
  const stack = useMemo(() => pruneFolderStack(tree, rawStack), [tree, rawStack])
  const folderId = stack[stack.length - 1] ?? null
  const searching = query.trim().length > 0

  const rows = useMemo(() => {
    const list = searching
      ? searchBookmarks(tree, query, SEARCH_LIMIT)
      : folderRows(tree, folderId, platform)
    return sortBookmarkRows(list, sortOrder).filter((node) => !pending.has(node.id))
  }, [tree, query, searching, folderId, platform, pending, sortOrder])
  // A re-order (or a delete) glides the rows to their new slots; a folder, a search or a view
  // change is a new list with no spatial relation to the old one and takes a fresh baseline.
  useFlip(listRef, true, {
    epoch: `${display}|${folderId ?? ''}|${searching ? query : ''}`
  })
  const order = useMemo(() => rows.map((node) => node.id), [rows])
  const selection = useMemo(() => pruneSelection(rawSelection, order), [rawSelection, order])

  // "Bookmark all tabs" lands in a folder and asks the open panel to show it; the folder may
  // reach the renderer a moment after the request does, so the request waits for it.
  const showFolder = useRef((id: string): void => {
    setStack(initialFolderStack(tree, platform, id))
    setQuery('')
    setSelection(NO_SELECTION)
  })
  useEffect(() => {
    showFolder.current = (id) => {
      setStack(initialFolderStack(tree, platform, id))
      setQuery('')
      setSelection(NO_SELECTION)
    }
  }, [tree, platform])
  useEffect(() => {
    let last = uiStore.get().overlayFolderId
    let wanted: string | null = null
    const has = (id: string): boolean =>
      (browserStore.get().state?.bookmarks ?? []).some((n) => n.id === id && n.type === 'folder')
    const apply = (): void => {
      if (wanted && has(wanted)) {
        const id = wanted
        wanted = null
        showFolder.current(id)
      }
    }
    const unsubscribeUi = uiStore.subscribe(() => {
      const id = uiStore.get().overlayFolderId
      if (id === last) return
      last = id
      wanted = id
      apply()
    })
    const unsubscribeBrowser = browserStore.subscribe(apply)
    if (last && !has(last)) wanted = last
    return () => {
      unsubscribeUi()
      unsubscribeBrowser()
    }
  }, [])

  const exitSelection = (): void => setSelection(NO_SELECTION)
  const goUp = (): void => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    setSelection(NO_SELECTION)
  }
  const step = selection.active ? exitSelection : stack.length > 1 && !searching ? goUp : null
  // The Move to… sheet above the panel takes the back gesture and Escape while it stands.
  usePanelStep(step !== null && moving === null, () => step?.())

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const enter = (node: BookmarkNode): void => {
    setStack((s) => [...s, node.id])
    setSelection(NO_SELECTION)
    setQuery('')
  }

  const open = (node: BookmarkNode): void => {
    if (node.type === 'folder') {
      enter(node)
      return
    }
    run('bookmark.open', { id: node.id, newTab: !tab, tabId: tab?.id ?? null })
    closeOverlay()
  }

  const openInNewTabs = (ids: readonly string[]): void => {
    const urls = ids.flatMap((id) => tree.urlsUnder(id))
    if (urls.length === 1) run('bookmark.open', { id: urls[0].id, newTab: true, tabId: null })
    else if (urls.length) run('bookmark.openAll', { ids: [...ids] })
    exitSelection()
  }

  const copyLinks = (ids: readonly string[]): void => {
    const urls = ids.flatMap((id) => tree.urlsUnder(id)).map((node) => node.url ?? '')
    if (!urls.length) return
    run('clipboard.writeText', {
      text: urls.join('\n'),
      confirmation: urls.length === 1 ? 'Link copied' : `${urls.length} links copied`
    })
    exitSelection()
  }

  const remove = (ids: readonly string[]): void => {
    const doomed = deletableIds(tree, ids)
    if (!doomed.length) return
    const only = doomed.length === 1 ? tree.get(doomed[0]) : null
    const message = only
      ? only.type === 'folder'
        ? 'Folder deleted'
        : 'Bookmark deleted'
      : `${doomed.length} deleted`
    removeWithUndo(doomed, message, () => run('bookmark.remove', { ids: doomed, quiet: true }))
    exitSelection()
  }

  const edit = (node: BookmarkNode): void => editBookmark(node.id)

  // Chrome's Select (`BookmarkManagerMediator`: `toggleSelectionForItem`): selection mode with
  // this row picked, as a long press on it starts.
  const select = (node: BookmarkNode): void => setSelection(startSelection(node.id))

  // Chrome's Move to… (`startFolderPickerActivity`): the folder picker for these rows; a
  // selection stays picked while the sheet stands and ends as the move runs (the rows leave).
  const moveTo = (ids: readonly string[]): void => setMoving([...ids])

  // Menu items are Title Case (v2 draft 9.1) and read as the core's bookmark menus do (#119:
  // "Edit…" opens a sheet, "Open All (N)" counts what a folder opens) – with ONE deliberate
  // split, ruled per door (W6-E6b): a folder's edit item says "Edit…" here, not the core's
  // "Rename…" (`src/core/menus.ts` `single?.type === 'url' ? 'Edit…' : 'Rename…'`). The desktop's
  // "Rename…" row is the manager's in-place rename of a folder in view (`BookmarkManager.tsx`
  // l.400-414, `setRenamingId`; pinned in `BookmarkManager.test.tsx` l.532-547): it renames alone,
  // so its word holds behind its door. This row opens the editor – HB-16's "Edit folder" sheet,
  // the name and the folder – so its word is Chrome's. Chrome 152 says Edit for every row
  // (`BookmarkManagerMediator` `createListMenuModelList`, l.1503: l.1522-1523 add
  // `bookmark_item_edit` after `bookmark_item_select` for a folder as for a page, l.1524's
  // `!isFolder()` gating Copy link alone; `createListMenuForBookmark`, l.1585, takes that list at
  // l.1589 and at l.1609-1613 opens `startEditActivity` for either; `IDS_BOOKMARK_ITEM_EDIT`
  // "Edit", grd l.4581-4583). The word is this panel's own literal, taken from no shared source.
  /** The addresses under `ids`, for the private rows (INC-08; a private tab is opened by URL). */
  const urlsUnder = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => tree.urlsUnder(id)).map((node) => node.url ?? '')
  const rowMenu = (node: BookmarkNode): void => {
    noteSheetOpener()
    const urlCount = tree.urlsUnder(node.id).length
    // Chrome 152's rows (HB-12) as far as the model reaches – Select, Edit, Copy link, Move to…,
    // Delete, Open in new tab, Open in Incognito – in this list's own order: the edits first,
    // the open rows, the link rows, the gap, Delete (§9.1; Chrome's Show in folder, Move up /
    // Move down and Open in new window have no counterpart here yet).
    const items: Array<LocalMenuItem | typeof MENU_GAP> =
      node.type === 'folder'
        ? [
            { label: 'Select', onSelect: () => select(node) },
            { label: 'Edit…', onSelect: () => edit(node) },
            { label: 'Move to…', onSelect: () => moveTo([node.id]) },
            {
              label: `Open All (${urlCount})`,
              enabled: urlCount > 0,
              onSelect: () => openInNewTabs([node.id])
            },
            ...openInPrivateItems(state.capabilities, urlsUnder([node.id]), exitSelection),
            MENU_GAP,
            { label: 'Delete', danger: true, onSelect: () => remove([node.id]) }
          ]
        : [
            { label: 'Select', onSelect: () => select(node) },
            { label: 'Edit…', onSelect: () => edit(node) },
            { label: 'Move to…', onSelect: () => moveTo([node.id]) },
            { label: 'Open in New Tab', onSelect: () => openInNewTabs([node.id]) },
            ...openInPrivateItems(state.capabilities, urlsUnder([node.id]), exitSelection),
            { label: S.menu('link.copyAddress'), onSelect: () => copyLinks([node.id]) },
            // The system share sheet, where the host has one (`app.share`, capabilities.share).
            ...(state.capabilities.share
              ? [
                  {
                    label: 'Share…',
                    onSelect: () => void run('app.share', { title: node.title, url: node.url })
                  }
                ]
              : []),
            MENU_GAP,
            { label: 'Delete', danger: true, onSelect: () => remove([node.id]) }
          ]
    void showLocalMenu(node.type === 'folder' ? 'folder' : 'bookmark', items, tab?.id ?? null, {
      title: node.title || (node.type === 'folder' ? 'Folder' : 'Bookmark')
    })
  }

  // Chrome's selection toolbar (HB-15) behind the header's More: Edit for exactly one picked
  // row (`selection_mode_edit_menu_id`; `BookmarkToolbarMediator` l.433 `showEdit =
  // !hasPartnerBookmark && numSelected == 1`, a lone folder included – it reads Edit…, as the
  // row's own does; the per-door word above), Move to… for any, then the open rows, Copy Link
  // Address, Delete.
  const selectionMenu = (): void => {
    noteSheetOpener()
    const ids = orderedSelection(selection, order)
    const only = ids.length === 1 ? tree.get(ids[0]) : null
    const urlCount = ids.reduce((n, id) => n + tree.urlsUnder(id).length, 0)
    void showLocalMenu(
      'selection',
      [
        ...(only ? [{ label: 'Edit…', onSelect: () => edit(only) }] : []),
        { label: 'Move to…', onSelect: () => moveTo(ids) },
        {
          label: urlCount === 1 ? 'Open in New Tab' : `Open All (${urlCount})`,
          enabled: urlCount > 0,
          onSelect: () => openInNewTabs(ids)
        },
        ...openInPrivateItems(state.capabilities, urlsUnder(ids), exitSelection),
        {
          label: S.menu('link.copyAddress', { n: urlCount }),
          enabled: urlCount > 0,
          onSelect: () => copyLinks(ids)
        },
        MENU_GAP,
        {
          label: ids.length === 1 ? 'Delete' : `Delete ${ids.length} Items`,
          danger: true,
          onSelect: () => remove(ids)
        }
      ],
      tab?.id ?? null,
      { title: `${ids.length} selected` }
    )
  }

  // The panel's own menu (bookmark all tabs, import, export) is the core's: it goes out through
  // `platform.menus.popup`, which on a phone comes back as the menu sheet.
  const panelMenu = (event: MouseEvent<HTMLElement>): void => {
    const r = event.currentTarget.getBoundingClientRect()
    run('bookmark.menu', { x: Math.round(r.left), y: Math.round(r.bottom) })
  }

  // Chrome's "Sort and view options" (`BookmarkToolbarMediator.onMenuItemClick`: the pick is
  // written to `BookmarkUiPrefs` and announced; the list re-queries from the pref). The two
  // settings are the device's own; the core's state carries the change back to the list.
  const sortViewMenu = (): void => {
    noteSheetOpener()
    void showLocalMenu(
      'bookmark',
      sortViewMenuItems(
        { sortOrder, display },
        (order) => {
          run('settings.update', { bookmarkRowSortOrder: order })
          announce(SORT_ORDER_ANNOUNCEMENTS[order])
        },
        (next) => {
          run('settings.update', { bookmarkRowDisplay: next })
          announce(DISPLAY_ANNOUNCEMENTS[next])
        }
      ),
      tab?.id ?? null,
      { title: SORT_VIEW_MENU_TITLE }
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const header = selection.active ? (
    <PhoneSelectionHeader
      count={selection.ids.size}
      onExit={exitSelection}
      actions={
        <>
          <PhoneIconButton
            label="Delete"
            onClick={() => remove(orderedSelection(selection, order))}
          >
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
          <PhoneIconButton label="More" onClick={selectionMenu}>
            <Ellipsis className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
        </>
      }
    />
  ) : (
    <PhoneHeader
      title={searching ? 'Bookmarks' : folderTitle(tree, folderId)}
      leading={
        stack.length > 1 && !searching ? (
          <PhoneIconButton label="Back" onClick={goUp}>
            <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
        ) : undefined
      }
      actions={
        <>
          <PhoneIconButton label={SORT_VIEW_MENU_TITLE} onClick={sortViewMenu}>
            <ListFilter className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
          <PhoneIconButton label="More bookmark actions" onClick={panelMenu}>
            <EllipsisVertical className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
        </>
      }
      onClose={() => closeOverlay()}
    />
  )

  return (
    <OverlayShell
      title="Bookmarks"
      variant="full"
      header={header}
      scroll={false}
      className="zen-phone-panel"
    >
      <PhoneSearchField
        value={query}
        onChange={setQuery}
        placeholder="Search bookmarks"
        scrolled={listScrolled}
      />
      <div
        ref={(el) => {
          listRef.current = el
          const detach = attachList(el)
          return () => {
            listRef.current = null
            if (typeof detach === 'function') detach()
          }
        }}
        className="zen-phone-list min-h-0 flex-1 overflow-y-auto pb-2"
        data-display={display}
      >
        {rows.length === 0 ? (
          searching ? (
            <PhoneEmptyNote>No matching bookmarks</PhoneEmptyNote>
          ) : folderId === null || isBookmarkRoot(folderId) ? (
            // Importing is the one obvious next step for a root with nothing in it (9.17).
            <PhoneEmptyNote
              action={{
                label: 'Import bookmarks',
                onSelect: () => run('bookmark.import', undefined)
              }}
            >
              Pages you bookmark will show up here
            </PhoneEmptyNote>
          ) : (
            <PhoneEmptyNote>This folder is empty</PhoneEmptyNote>
          )
        ) : (
          rows.map((node) => (
            // The cell the FLIP tracker glides (`data-cell`): the row's own box, keyed by the node.
            <div key={node.id} data-cell={node.id}>
              <BookmarkNodeRow
                node={node}
                childCount={node.type === 'folder' ? tree.children(node.id).length : 0}
                display={display}
                pictureTabId={display === 'visual' ? pictureTabFor(node, state.tabs) : null}
                selecting={selection.active}
                selected={selection.ids.has(node.id)}
                onTap={() =>
                  selection.active ? setSelection(toggleSelected(selection, node.id)) : open(node)
                }
                onLongPress={
                  isBookmarkRoot(node.id)
                    ? undefined
                    : () =>
                        setSelection(
                          selection.active
                            ? toggleSelected(selection, node.id)
                            : startSelection(node.id)
                        )
                }
                onMenu={isBookmarkRoot(node.id) ? undefined : () => rowMenu(node)}
              />
            </div>
          ))
        )}
      </div>
      {moving !== null && (
        <BookmarkMoveSheet
          tree={tree}
          platform={platform}
          ids={moving}
          onClose={() => setMoving(null)}
          onMoved={exitSelection}
        />
      )}
    </OverlayShell>
  )
}

function BookmarkNodeRow({
  node,
  childCount,
  display,
  pictureTabId,
  selecting,
  selected,
  onTap,
  onLongPress,
  onMenu
}: {
  node: BookmarkNode
  childCount: number
  /** Chrome's `BookmarkRowDisplayPref`: an image tile (visual) or the favicon row (compact). */
  display: BookmarkRowDisplay
  /** The open tab whose card picture a visual tile shows, when one is on the page (`pictureTabFor`). */
  pictureTabId: string | null
  selecting: boolean
  selected: boolean
  onTap: () => void
  onLongPress?: () => void
  /** The trailing menu; roots have none and show a chevron instead. */
  onMenu?: () => void
}): JSX.Element {
  const folder = node.type === 'folder'
  const visual = display === 'visual'
  const title = node.title || (folder ? 'Folder' : displayUrl(node.url ?? ''))
  // The tile's picture – the tab's card picture, the full cover failing that – held only while
  // the row is a visual one (a compact row reads none).
  const pictureSrc = useThumbnail(visual ? pictureTabId : null)
  const menuButton = onMenu ? (
    <PhoneIconButton label={`More options for ${title}`} onClick={onMenu}>
      <EllipsisVertical className="h-5 w-5" strokeWidth={1.75} />
    </PhoneIconButton>
  ) : null
  // The row's lead is the row's 20 glyph; a tile's glyph is the tile's 32 (v2 §9.29: a 64 tile
  // takes a 32 icon, never the row's 20). The favicon fills its `.zen-list-mark` box either way.
  const mark = folder ? (
    <Folder className={visual ? 'h-8 w-8' : 'h-5 w-5'} strokeWidth={1.75} />
  ) : visual ? (
    <RowFavicon
      src={node.favicon}
      page={node.url ?? null}
      fallback={<Globe className="zen-list-standin h-8 w-8" strokeWidth={1.75} />}
    />
  ) : (
    <RowFavicon
      src={node.favicon}
      page={node.url ?? null}
      fallback={<Globe className="zen-list-standin h-5 w-5" strokeWidth={1.75} />}
    />
  )
  // Chrome's visual row (`ImprovedBookmarkRowCoordinator`): the page's image, else the favicon on
  // the tile; a folder shows its glyph (Chrome layers its first two children's images under it).
  const picture = visual ? (
    pictureSrc ? (
      <img src={pictureSrc} alt="" className="zen-list-page" draggable={false} />
    ) : (
      <span className="zen-list-mark">{mark}</span>
    )
  ) : undefined
  return (
    <PhoneListRow
      icon={visual ? undefined : mark}
      picture={picture}
      title={title}
      subtitle={folder ? undefined : displayUrl(node.url ?? '')}
      ariaLabel={folder ? `${title}, folder, ${folderCountLabel(childCount)}` : undefined}
      trailing={
        folder ? (
          <>
            <span className="zen-list-value shrink-0">{folderCountLabel(childCount)}</span>
            {menuButton ?? (
              // The folder's chevron is a trailing indicator, 16 on both platforms (§9.3); the
              // 44 box keeps it where the menu button's glyph sits on the other rows.
              <span className="flex h-11 w-11 shrink-0 items-center justify-center" aria-hidden>
                <ChevronRight className="h-4 w-4 opacity-60" strokeWidth={1.75} />
              </span>
            )}
          </>
        ) : (
          menuButton
        )
      }
      selecting={selecting}
      selected={selected}
      onTap={onTap}
      onLongPress={onLongPress}
    />
  )
}
