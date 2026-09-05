import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Clock, Trash2 } from 'lucide-react'
import type { HistoryEntry, UIState } from '@shared/types'
import { displayUrl } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay } from '@renderer/lib/ui'
import { relativeTime } from '@renderer/lib/utils'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { EmptyNote, OverlayShell } from './OverlayShell'

export function HistoryPanel({ state }: { state: UIState }): JSX.Element {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void cmd('history.search', { query, limit: 200 }).then((list) => {
        if (!cancelled) setEntries(list)
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, version])

  const open = (url: string, newTab: boolean): void => {
    const tab = activeTab(state)
    run('urlbar.submit', { input: url, newTab: newTab || !tab, tabId: tab?.id ?? null })
    closeOverlay()
  }

  return (
    <OverlayShell
      title="History"
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            run('history.clear', undefined)
            setVersion((v) => v + 1)
          }}
        >
          Clear all
        </Button>
      }
    >
      <div className="p-3">
        <Input
          autoFocus
          placeholder="Search history"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {entries.length === 0 ? (
        <EmptyNote>{query ? 'No matching pages.' : 'Pages you visit will show up here.'}</EmptyNote>
      ) : (
        <ul className="px-2 pb-2">
          {entries.map((e) => (
            <li
              key={e.url}
              className="group flex h-11 items-center gap-3 rounded-lg px-2 hover:bg-[var(--zen-element-bg)]"
            >
              {e.favicon ? (
                <img
                  src={e.favicon}
                  alt=""
                  className="h-4 w-4 rounded-[3px]"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <Clock className="h-4 w-4 opacity-50" />
              )}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={(ev) => open(e.url, ev.ctrlKey || ev.metaKey)}
                onAuxClick={(ev) => ev.button === 1 && open(e.url, true)}
              >
                <div className="truncate text-[13px]">{e.title}</div>
                <div className="truncate text-[11.5px] text-[var(--zen-muted)]">
                  {displayUrl(e.url)}
                </div>
              </button>
              <span className="shrink-0 text-[11px] text-[var(--zen-muted)]">
                {relativeTime(e.lastVisit)}
              </span>
              <button
                type="button"
                className="zen-toolbar-button h-6 w-6 opacity-0 group-hover:opacity-100"
                title="Remove from history"
                onClick={() => {
                  run('history.delete', { url: e.url })
                  setEntries((list) => list.filter((x) => x.url !== e.url))
                }}
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
