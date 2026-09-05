import type { JSX } from 'react'
import { useState } from 'react'
import { Bookmark, Trash2 } from 'lucide-react'
import type { UIState } from '@shared/types'
import { displayUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay } from '@renderer/lib/ui'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { EmptyNote, OverlayShell } from './OverlayShell'

export function BookmarksPanel({ state }: { state: UIState }): JSX.Element {
  const [query, setQuery] = useState('')
  const tab = activeTab(state)
  const q = query.trim().toLowerCase()
  const list = state.bookmarks.filter((b) => !q || `${b.title} ${b.url}`.toLowerCase().includes(q))

  const open = (url: string, newTab: boolean): void => {
    run('urlbar.submit', { input: url, newTab: newTab || !tab, tabId: tab?.id ?? null })
    closeOverlay()
  }

  return (
    <OverlayShell
      title="Bookmarks"
      actions={
        tab && !tab.url.startsWith('zen://') ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run('bookmark.toggle', { tabId: tab.id })}
          >
            {tab.bookmarked ? 'Remove current' : 'Bookmark current'}
          </Button>
        ) : null
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
          {list.map((b) => (
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
                onClick={(ev) => open(b.url, ev.ctrlKey || ev.metaKey)}
                onAuxClick={(ev) => ev.button === 1 && open(b.url, true)}
              >
                <div className="truncate text-[13px]">{b.title}</div>
                <div className="truncate text-[11.5px] text-[var(--zen-muted)]">
                  {displayUrl(b.url)}
                </div>
              </button>
              <button
                type="button"
                className="zen-toolbar-button h-6 w-6 opacity-0 group-hover:opacity-100"
                title="Remove bookmark"
                onClick={() => run('bookmark.remove', { id: b.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </OverlayShell>
  )
}
