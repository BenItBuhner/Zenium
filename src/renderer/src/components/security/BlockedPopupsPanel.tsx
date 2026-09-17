import type { JSX } from 'react'
import { useEffect } from 'react'
import { AppWindow, ExternalLink } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  blockedPopupsOf,
  openBlockedPopups,
  originOf,
  popupsAllowedFor,
  siteLabel
} from '@renderer/lib/security'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useSpringPresence } from '@renderer/hooks/useSpringPresence'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'

const PANEL_WIDTH = 360

/**
 * What the pop-up blocker refused for one tab: the pages (and app launches) the site tried to open
 * without being asked, each with an Open button, and the switch that lets the site open windows on
 * its own from now on. Anchored under the address pill on desktop, a sheet above the bar on phones.
 */
export function BlockedPopupsPanel({
  state,
  panel
}: {
  state: UIState
  panel: NonNullable<ReturnType<typeof uiStore.get>['blockedPopupsPanel']>
}): JSX.Element | null {
  const tab = state.tabs[panel.tabId]
  const entries = blockedPopupsOf(state, panel.tabId)
  const allowed = popupsAllowedFor(state, tab)
  const origin = tab ? originOf(tab.url) : null
  const anchored = panel.anchor
  const left = anchored
    ? Math.max(8, Math.min(anchored.x - 12, window.innerWidth - PANEL_WIDTH - 8))
    : 12
  const placement: React.CSSProperties = anchored
    ? { left, top: anchored.y + anchored.height + 6, width: PANEL_WIDTH }
    : { left, right: 12, bottom: 'calc(var(--zen-inset-bottom) + 72px)' }
  // Grow out of the indicator that was tapped (or up out of the phone's bar).
  const { style, close } = useSpringPresence(
    () => uiStore.set({ blockedPopupsPanel: null }),
    anchored ? `${anchored.x + anchored.width / 2 - left}px 0%` : '50% 100%'
  )

  // The tab is gone, or the last entry was opened and nothing is left to say.
  useEffect(() => {
    if (!tab || (entries.length === 0 && !allowed)) close()
  }, [tab, entries.length, allowed, close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  if (!tab) return null

  const pages = entries.filter((p) => p.kind === 'popup').length
  const launches = entries.length - pages
  const summary =
    entries.length === 0
      ? `This site may open pop-ups on its own.`
      : [
          pages > 0 && `${pages} ${pages === 1 ? 'pop-up' : 'pop-ups'}`,
          launches > 0 && `${launches} ${launches === 1 ? 'app launch' : 'app launches'}`
        ]
          .filter(Boolean)
          .join(' and ')
          .replace(/^./, (c) => c.toUpperCase()) + ' blocked on this page.'

  return (
    <div className="absolute inset-0 z-50" onMouseDown={close}>
      <div
        className="zen-panel absolute flex flex-col overflow-hidden rounded-2xl"
        style={{ ...placement, ...style }}
        role="dialog"
        aria-label="Blocked pop-ups"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[var(--zen-element-bg)]">
            <AppWindow className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13.5px] font-semibold">Pop-ups blocked</h2>
            <p className="text-[12px] text-[var(--zen-muted)]">{summary}</p>
          </div>
        </div>
        {entries.length > 0 && (
          <ul className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto px-2 py-1">
            {entries.map((entry) => (
              <li
                key={entry.url}
                className="flex h-9 items-center gap-2.5 rounded-[10px] px-2 hover:bg-[var(--zen-element-bg)]"
              >
                {entry.kind === 'external' ? (
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
                ) : (
                  <AppWindow className="h-3.5 w-3.5 shrink-0 opacity-60" />
                )}
                <span className="min-w-0 flex-1 truncate text-[12.5px]" title={entry.url} dir="ltr">
                  {entry.url}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => run('popups.open', { tabId: tab.id, url: entry.url })}
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3 px-4 pt-2 pb-3.5">
          {origin ? (
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
              <Switch
                checked={allowed}
                onCheckedChange={(v) => run('popups.setSiteAllowed', { tabId: tab.id, allow: v })}
              />
              <span className={cn('min-w-0 truncate text-[12.5px]')}>
                Always allow pop-ups on {siteLabel(origin)}
              </span>
            </label>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              run('popups.dismiss', { tabId: tab.id })
              close()
            }}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Phones have no room for an indicator in the address pill: a chip above the bar says a pop-up
 * was blocked and opens the list.
 */
export function BlockedPopupsChip({
  state,
  tabId
}: {
  state: UIState
  tabId: string
}): JSX.Element | null {
  const entries = blockedPopupsOf(state, tabId)
  if (entries.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-40 flex justify-center px-4"
      style={{ bottom: 'calc(var(--zen-inset-bottom) + 64px)' }}
    >
      <button
        type="button"
        className="zen-panel zen-animate-pop pointer-events-auto flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px]"
        onClick={() => openBlockedPopups(tabId, null)}
      >
        <AppWindow className="h-4 w-4" />
        <span>{entries.length === 1 ? 'Pop-up blocked' : `${entries.length} pop-ups blocked`}</span>
        <span className="font-medium text-[var(--zen-accent)]">Show</span>
      </button>
    </div>
  )
}
