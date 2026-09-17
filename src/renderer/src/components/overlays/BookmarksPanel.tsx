import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Bookmark, Download, Trash2, Upload } from 'lucide-react'
import type { BookmarkNode, UIState } from '@shared/types'
import { BookmarkTree, isBookmarkRoot, searchBookmarks } from '@shared/bookmarks'
import { displayUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay } from '@renderer/lib/ui'
import { useViewport } from '@renderer/lib/formFactor'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { EmptyNote, OverlayShell } from './OverlayShell'

/**
 * The bookmarks overlay on the tree model: every bookmark from every folder with its folder path,
 * search across the tree, import and export. The folder-aware manager and the star dialog are
 * the UI program's surfaces and replace this panel.
 */
export function BookmarksPanel({ state }: { state: UIState }): JSX.Element {
  const [query, setQuery] = useState('')
  const phone = useViewport().formFactor === 'phone'
  const tab = activeTab(state)
  const tree = useMemo(() => new BookmarkTree(state.bookmarks), [state.bookmarks])
  const q = query.trim()
  const list = useMemo(
    () =>
      q ? searchBookmarks(tree, q, Infinity, 'url') : tree.flat().filter((n) => n.type === 'url'),
    [tree, q]
  )

  const open = (id: string, newTab: boolean): void => {
    run('bookmark.open', { id, newTab: newTab || !tab, tabId: tab?.id ?? null })
    closeOverlay()
  }

  /** "Work / Docs": the folders above a bookmark, without the root's name. */
  const folderLabel = (node: BookmarkNode): string =>
    tree
      .path(node.id)
      .slice(0, -1)
      .filter((p) => !isBookmarkRoot(p.id))
      .map((p) => p.title)
      .join(' / ')

  return (
    <OverlayShell
      title="Bookmarks"
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            title="Import bookmarks from a Netscape HTML file"
            onClick={() => run('bookmark.import', undefined)}
          >
            <Upload className="h-3.5 w-3.5" />
            {phone ? null : 'Import'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Export bookmarks as a Netscape HTML file"
            onClick={() => run('bookmark.export', undefined)}
          >
            <Download className="h-3.5 w-3.5" />
            {phone ? null : 'Export'}
          </Button>
          {tab && !tab.url.startsWith('zen://') ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => run('bookmark.toggle', { tabId: tab.id })}
            >
              {tab.bookmarked ? 'Remove current' : 'Bookmark current'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="p-3">
        <Input
          autoFocus
          placeholder="Search bookmarks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {list.length === 0 ? (
        <EmptyNote>
          {q ? 'No matching bookmarks.' : 'Press Ctrl+D on any page to bookmark it.'}
        </EmptyNote>
      ) : (
        <ul className="px-2 pb-2">
          {list.map((b) => {
            const folder = folderLabel(b)
            return (
              <li
                key={b.id}
                className="group flex h-11 items-center gap-3 rounded-lg px-2 hover:bg-[var(--zen-element-bg)]"
              >
                {b.favicon ? (
                  <img
                    src={b.favicon}
                    alt=""
                    className="h-4 w-4 rounded-[3px]"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <Bookmark className="h-4 w-4 opacity-50" />
                )}
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={(ev) => open(b.id, ev.ctrlKey || ev.metaKey)}
                  onAuxClick={(ev) => ev.button === 1 && open(b.id, true)}
                >
                  <div className="truncate text-[13px]">{b.title}</div>
                  <div className="truncate text-[11.5px] text-[var(--zen-muted)]">
                    {folder ? `${folder} · ` : ''}
                    {displayUrl(b.url ?? '')}
                  </div>
                </button>
                <button
                  type="button"
                  className="zen-toolbar-button h-6 w-6 opacity-0 group-hover:opacity-100"
                  title="Remove bookmark"
                  onClick={() => run('bookmark.remove', { ids: [b.id] })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </OverlayShell>
  )
}
