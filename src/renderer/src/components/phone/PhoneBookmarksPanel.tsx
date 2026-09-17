import type { JSX, MouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  EllipsisVertical,
  Folder,
  Globe,
  Trash2
} from 'lucide-react'
import type { BookmarkNode, UIState } from '@shared/types'
import { isBookmarkRoot, searchBookmarks } from '@shared/bookmarks'
import { displayUrl } from '@shared/url'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { editBookmark } from '@renderer/lib/bookmarkEdit'
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
import { activeTab } from '@renderer/lib/selectors'
import {
  browserStore,
  closeOverlay,
  MENU_GAP,
  showLocalMenu,
  uiStore,
  type LocalMenuItem
} from '@renderer/lib/ui'
import { EmptyNote, OverlayShell } from '../overlays/OverlayShell'
import {
  PhoneHeader,
  PhoneIconButton,
  PhoneListRow,
  PhoneSearchField,
  PhoneSelectionHeader,
  RowFavicon
} from './PhoneList'
import { removeWithUndo, useBookmarkTree, usePanelStep, usePendingDeletes } from './phonePanel'

const SEARCH_LIMIT = 200

/**
 * Bookmarks on a phone (design-language 8.1, 8.2, 8.7, 8.8): one folder at a time under a 56
 * header – folders as rows that push in, bookmarks as rows with favicon, title and address and
 * a trailing menu (edit, open in a new tab, copy the link, delete) – with a search field over
 * the whole tree. A long press starts selection mode, whose header replaces the panel's; the
 * back gesture leaves it, then climbs out of folders, then closes the panel. Deletes are
 * undoable from their toast. The editor is the `BookmarkEditSheet` the shell renders.
 */
export function PhoneBookmarksPanel({ state }: { state: UIState }): JSX.Element {
  const tree = useBookmarkTree(state)
  const { platform } = state
  const tab = activeTab(state)
  const [rawStack, setStack] = useState<readonly FolderId[]>(() =>
    initialFolderStack(tree, platform, uiStore.get().overlayFolderId)
  )
  const [query, setQuery] = useState('')
  const [rawSelection, setSelection] = useState<Selection>(NO_SELECTION)
  const pending = usePendingDeletes()
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })

  // A folder deleted elsewhere (sync, another window) unwinds the stack to what still exists.
  const stack = useMemo(() => pruneFolderStack(tree, rawStack), [tree, rawStack])
  const folderId = stack[stack.length - 1] ?? null
  const searching = query.trim().length > 0

  const rows = useMemo(() => {
    const list = searching
      ? searchBookmarks(tree, query, SEARCH_LIMIT)
      : folderRows(tree, folderId, platform)
    return list.filter((node) => !pending.has(node.id))
  }, [tree, query, searching, folderId, platform, pending])
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
  usePanelStep(step !== null, () => step?.())

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
    removeWithUndo(doomed, message, () => run('bookmark.remove', { ids: doomed }))
    exitSelection()
  }

  const edit = (node: BookmarkNode): void => editBookmark(node.id)

  const rowMenu = (node: BookmarkNode): void => {
    const urlCount = tree.urlsUnder(node.id).length
    const items: Array<LocalMenuItem | typeof MENU_GAP> =
      node.type === 'folder'
        ? [
            { label: 'Rename', onSelect: () => edit(node) },
            {
              label: 'Open all in new tabs',
              enabled: urlCount > 0,
              onSelect: () => openInNewTabs([node.id])
            },
            MENU_GAP,
            { label: 'Delete', danger: true, onSelect: () => remove([node.id]) }
          ]
        : [
            { label: 'Edit', onSelect: () => edit(node) },
            { label: 'Open in new tab', onSelect: () => openInNewTabs([node.id]) },
            { label: 'Copy link', onSelect: () => copyLinks([node.id]) },
            MENU_GAP,
            { label: 'Delete', danger: true, onSelect: () => remove([node.id]) }
          ]
    void showLocalMenu(node.type === 'folder' ? 'folder' : 'bookmark', items, tab?.id ?? null, {
      title: node.title || (node.type === 'folder' ? 'Folder' : 'Bookmark')
    })
  }

  const selectionMenu = (): void => {
    const ids = orderedSelection(selection, order)
    const urlCount = ids.reduce((n, id) => n + tree.urlsUnder(id).length, 0)
    void showLocalMenu(
      'selection',
      [
        {
          label: urlCount === 1 ? 'Open in new tab' : 'Open in new tabs',
          enabled: urlCount > 0,
          onSelect: () => openInNewTabs(ids)
        },
        {
          label: urlCount === 1 ? 'Copy link' : 'Copy links',
          enabled: urlCount > 0,
          onSelect: () => copyLinks(ids)
        },
        MENU_GAP,
        { label: 'Delete', danger: true, onSelect: () => remove(ids) }
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
        <PhoneIconButton label="More bookmark actions" onClick={panelMenu}>
          <EllipsisVertical className="h-5 w-5" strokeWidth={1.75} />
        </PhoneIconButton>
      }
      onClose={() => closeOverlay()}
    />
  )

  return (
    <OverlayShell title="Bookmarks" variant="full" header={header} scroll={false}>
      <PhoneSearchField value={query} onChange={setQuery} placeholder="Search bookmarks" />
      <div ref={fade} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 ? (
          <EmptyNote>
            {searching
              ? 'No matching bookmarks.'
              : folderId === null || isBookmarkRoot(folderId)
                ? 'Pages you bookmark will show up here.'
                : 'This folder is empty.'}
          </EmptyNote>
        ) : (
          rows.map((node) => (
            <BookmarkNodeRow
              key={node.id}
              node={node}
              childCount={node.type === 'folder' ? tree.children(node.id).length : 0}
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
          ))
        )}
      </div>
    </OverlayShell>
  )
}

function BookmarkNodeRow({
  node,
  childCount,
  selecting,
  selected,
  onTap,
  onLongPress,
  onMenu
}: {
  node: BookmarkNode
  childCount: number
  selecting: boolean
  selected: boolean
  onTap: () => void
  onLongPress?: () => void
  /** The trailing menu; roots have none and show a chevron instead. */
  onMenu?: () => void
}): JSX.Element {
  const folder = node.type === 'folder'
  const title = node.title || (folder ? 'Folder' : displayUrl(node.url ?? ''))
  const menuButton = onMenu ? (
    <PhoneIconButton label={`More options for ${title}`} onClick={onMenu}>
      <EllipsisVertical className="h-5 w-5 opacity-60" strokeWidth={1.75} />
    </PhoneIconButton>
  ) : null
  return (
    <PhoneListRow
      icon={
        folder ? (
          <Folder className="h-5 w-5 opacity-70" strokeWidth={1.75} />
        ) : (
          <RowFavicon
            src={node.favicon}
            fallback={<Globe className="h-5 w-5 opacity-60" strokeWidth={1.75} />}
          />
        )
      }
      title={title}
      subtitle={folder ? undefined : displayUrl(node.url ?? '')}
      ariaLabel={folder ? `${title}, folder, ${folderCountLabel(childCount)}` : undefined}
      trailing={
        folder ? (
          <>
            <span className="zen-list-value shrink-0">{folderCountLabel(childCount)}</span>
            {menuButton ?? (
              <ChevronRight className="mr-2 h-5 w-5 shrink-0 opacity-60" strokeWidth={1.75} />
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
