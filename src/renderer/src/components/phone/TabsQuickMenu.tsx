import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { PhoneBarPosition, Rect, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { closeWithUndo } from '@renderer/lib/closeUndo'
import { stageStore } from '@renderer/lib/gestures/stage'
import { activeTab } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

const WIDTH = 208
const GAP = 8
const MARGIN = 8

/**
 * The Tabs button's hold: a small menu anchored to the button – New Tab and Close Tab – above
 * a bar docked at the bottom, below one docked at the top. It is a menu on the v2 draft's
 * panel, sized for a thumb; a tap anywhere else, the system back or Escape closes it.
 */
export function TabsQuickMenu({
  state,
  anchor,
  edge,
  onClose
}: {
  state: UIState
  /** The Tabs button, in window coordinates. */
  anchor: Rect
  edge: PhoneBarPosition
  onClose: () => void
}): JSX.Element {
  const tab = activeTab(state)
  const insets = uiStore.use((s) => s.insets)
  const panel = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(anchor.x + anchor.width / 2 - WIDTH / 2)

  useBackSurface({ name: 'tabs-quick-menu', onCommit: onClose })
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
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
  // The chrome moving on underneath (the overview or the URL bar opening) takes the menu with it.
  useEffect(() => {
    const check = (): void => {
      if (stageStore.get().overview.phase !== 'closed' || uiStore.get().urlbar.open) close.current()
    }
    const unsubscribes = [stageStore.subscribe(check), uiStore.subscribe(check)]
    return () => unsubscribes.forEach((off) => off())
  }, [])

  // Centred on the button, kept inside the window.
  useLayoutEffect(() => {
    const width = panel.current?.offsetWidth ?? WIDTH
    const min = insets.left + MARGIN
    const max = window.innerWidth - insets.right - MARGIN - width
    setLeft(Math.max(min, Math.min(max, anchor.x + anchor.width / 2 - width / 2)))
  }, [anchor, insets.left, insets.right])

  const pick = (action: () => void): void => {
    onClose()
    action()
  }
  /** Close Tab comes with Undo on the toast, as the overview's closes do (lib/closeUndo.ts). */
  const closeTab = (): void => {
    if (!tab) return
    closeWithUndo({
      tabs: [tab],
      settings: state.settings,
      activeTabId: tab.id,
      close: () => run('tab.close', { tabId: tab.id })
    })
  }
  const vertical =
    edge === 'bottom'
      ? { bottom: window.innerHeight - anchor.y + GAP }
      : { top: anchor.y + anchor.height + GAP }

  return (
    <div
      className="absolute inset-0 z-[60]"
      data-shell-chrome
      onClick={onClose}
      // The hold that opened the menu ends with the platform's long-press (a context menu
      // event) landing here: not a dismissal, and not the WebView's own menu either.
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={panel}
        role="menu"
        aria-label="Tabs"
        className={cn(
          'zen-quick-menu zen-animate-pop absolute flex flex-col',
          edge === 'bottom' ? 'origin-bottom' : 'origin-top'
        )}
        style={{ left, width: WIDTH, ...vertical }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          className="zen-quick-menu-item"
          onClick={() => pick(() => window.dispatchEvent(new CustomEvent('zen-new-tab')))}
        >
          <Plus className="h-5 w-5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">New Tab</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="zen-quick-menu-item"
          disabled={!tab}
          onClick={() => pick(closeTab)}
        >
          <X className="h-5 w-5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">Close Tab</span>
        </button>
      </div>
    </div>
  )
}
