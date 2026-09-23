import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, History } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { NavigationDirection, NavigationHistoryEntry, Rect, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { displayUrl } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { stageStore } from '@renderer/lib/gestures/stage'
import { PAGE_GLYPHS } from '@renderer/lib/pageGlyphs'
import { openPage } from '@renderer/lib/pages'
import { useLightDismiss } from '@renderer/lib/popoverStore'
import {
  ChromePortal,
  POPOVER_WIDTH,
  placePopover,
  popoverStyle,
  toRect,
  viewportSize
} from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

/** Chrome's `NavigationPopup.MAXIMUM_HISTORY_ITEMS`: the most entries the popup lists. */
export const HISTORY_MENU_MAX = 8

/**
 * The Back (or Forward) button's hold: the tab's history in that direction, nearest first, up to
 * eight rows of favicon and title (the URL where the page had none), then a rule and "Show full
 * history" – Chrome's `NavigationPopup` on its tablet toolbar's Back (GN-08), which leaves the
 * full-history row out of an incognito window as this does on a private tab. A row jumps the tab
 * to that entry (`tab.goToIndex`) – picked by the finger that opened the popup dragging to it
 * and releasing (§9.13's popover exception as granted: the finger never lifts; `useBarHold`'s
 * release reads the `data-hold-pick` mark), or by a tap after a release elsewhere, as Chrome
 * Android's popup is used. A popover on the v2 menu surface through the chrome layer
 * (§9.20's placement: hanging from the bar's edge, start-aligned on the button, flipped above a
 * bar docked at the bottom); the layer's light dismiss, the system back and Escape close it, and
 * so does the tab moving on underneath – a navigation, another tab, the overview or the URL bar
 * opening.
 */
export function BackHistoryMenu({
  state,
  anchor,
  direction,
  onClose
}: {
  state: UIState
  /** The Back or Forward button, in window coordinates. */
  anchor: Rect
  direction: NavigationDirection
  onClose: () => void
}): JSX.Element | null {
  const tab = activeTab(state)
  const tabId = tab?.id ?? null
  const isPrivate = tab?.containerId === PRIVATE_CONTAINER_ID
  const panel = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<NavigationHistoryEntry[] | null>(null)

  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useBackSurface({ name: 'back-history-menu', onCommit: onClose })
  useLightDismiss(panel, () => close.current())

  // The stack, read once when the popup opens; an empty answer (the tab moved meanwhile) closes.
  const opened = useRef({ tabId, url: tab?.url ?? null })
  useEffect(() => {
    const id = opened.current.tabId
    if (!id) {
      close.current()
      return
    }
    let live = true
    cmd('tab.navigationHistory', { tabId: id, direction, limit: HISTORY_MENU_MAX })
      .then((rows) => {
        if (!live) return
        if (rows.length === 0) close.current()
        else setEntries(rows)
      })
      .catch(() => {
        if (live) close.current()
      })
    return () => {
      live = false
    }
  }, [direction])

  // The tab moving on underneath – another tab in front, or this one navigating – takes the
  // popup with it: its rows would describe a stack that is gone.
  useEffect(() => {
    if (tabId !== opened.current.tabId || (tab?.url ?? null) !== opened.current.url) close.current()
  }, [tabId, tab?.url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => {
    const check = (): void => {
      if (stageStore.get().overview.phase !== 'closed' || uiStore.get().urlbar.open) close.current()
    }
    const unsubscribes = [stageStore.subscribe(check), uiStore.subscribe(check)]
    return () => unsubscribes.forEach((off) => off())
  }, [])

  // §9.20: from the bar the button sits in – below a top-docked bar, above a bottom-docked one –
  // start-aligned on the button, or end-aligned for a button in the bar's trailing half. A menu
  // takes the room to the window's margin (`capHeight: false`), its list scrolling past it.
  const box = useMemo(() => {
    const bar = document.querySelector('.zen-phone-bar')?.getBoundingClientRect()
    return placePopover(
      anchor,
      bar ? toRect(bar) : anchor,
      viewportSize(),
      POPOVER_WIDTH.list,
      undefined,
      undefined,
      { capHeight: false }
    )
  }, [anchor])

  if (!entries || !tabId) return null

  const pick = (action: () => void): void => {
    onClose()
    action()
  }

  return (
    <ChromePortal>
      <div
        ref={panel}
        role="menu"
        aria-label={direction === 'back' ? 'Back history' : 'Forward history'}
        data-testid="back-history-popup"
        data-direction={direction}
        className={cn(
          'zen-quick-menu zen-animate-pop fixed flex flex-col overflow-y-auto',
          box.side === 'above' ? 'origin-bottom' : 'origin-top'
        )}
        style={popoverStyle(box)}
        // The hold that opened the popup ends with the platform's long-press (a context menu
        // event) landing here: not a dismissal, and not the WebView's own menu either.
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry) => (
          <button
            key={entry.index}
            type="button"
            role="menuitem"
            className="zen-quick-menu-item"
            data-testid="back-history-entry"
            data-index={entry.index}
            data-hold-pick=""
            onClick={() => pick(() => run('tab.goToIndex', { tabId, index: entry.index }))}
          >
            <EntryFavicon entry={entry} />
            <span className="min-w-0 flex-1 truncate">{entry.title || displayUrl(entry.url)}</span>
          </button>
        ))}
        {!isPrivate && (
          <>
            <div className="zen-v2-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="zen-quick-menu-item"
              data-testid="back-history-full"
              data-hold-pick=""
              onClick={() => pick(() => openPage('history'))}
            >
              <History className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 truncate">Show full history</span>
            </button>
          </>
        )}
      </div>
    </ChromePortal>
  )
}

/**
 * The row's 16 px favicon: an internal page's registered glyph (v2 §10.1), the icon history
 * knows for the URL, the globe for a site with none or a broken one – Chrome's default favicon
 * until the fetched one lands.
 */
function EntryFavicon({ entry }: { entry: NavigationHistoryEntry }): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const glyph = internalPageOf(entry.url)?.glyph
  if (glyph) {
    const Glyph = PAGE_GLYPHS[glyph]
    return <Glyph className="zen-histmenu-favicon" strokeWidth={2} aria-hidden />
  }
  if (entry.favicon && broken !== entry.favicon) {
    return (
      <img
        src={entry.favicon}
        alt=""
        className="zen-histmenu-favicon rounded-sm"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(entry.favicon)}
      />
    )
  }
  return <Globe className="zen-histmenu-favicon zen-histmenu-favicon-fallback" aria-hidden />
}
