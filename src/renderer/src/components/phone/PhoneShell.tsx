import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ArrowLeft, Lock, MoreHorizontal, Plus, Search } from 'lucide-react'
import type { UIState } from '@shared/types'
import { displayUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { activeSpace, activeTab, essentialsFor, tabsOf } from '@renderer/lib/selectors'
import { closeDrawer, openDrawer, openUrlbar, type UiState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ContentArea } from '../content/ContentArea'
import { Onboarding } from '../overlays/Onboarding'
import { Sidebar } from '../sidebar/Sidebar'
import { Favicon } from '../sidebar/Favicon'

interface Props {
  state: UIState
  ui: UiState
  isDark: boolean
}

/**
 * Phone layout: the content card fills the screen above a bottom bar; the sidebar (spaces,
 * essentials, pinned tabs, folders) lives in a drawer that slides in from the tabs side. Every
 * component inside is the same one the desktop layout uses.
 */
export function PhoneShell({ state, ui, isDark }: Props): JSX.Element {
  const tab = activeTab(state)
  const side = state.settings.sidebarSide
  const onboarding = !state.settings.onboardingDone
  const htmlFullscreen = state.window.htmlFullscreenTabId !== null
  const activeTabId = tab?.id ?? null

  // Picking a tab (or opening chrome UI) in the drawer closes it.
  const lastActive = useRef(activeTabId)
  useEffect(() => {
    if (lastActive.current !== activeTabId && ui.drawerOpen) closeDrawer()
    lastActive.current = activeTabId
  }, [activeTabId, ui.drawerOpen])

  if (htmlFullscreen) return <div className="h-full w-full bg-black" />

  const barHidden = ui.urlbar.open
  return (
    <div
      className="zen-window relative flex h-full w-full flex-col overflow-hidden"
      data-dark={isDark}
      style={{
        paddingTop: 'var(--zen-inset-top)',
        paddingLeft: 'var(--zen-inset-left)',
        paddingRight: 'var(--zen-inset-right)'
      }}
    >
      <div className="zen-texture" />
      <main
        className="relative flex min-h-0 flex-1 flex-col"
        style={{
          paddingTop: 'var(--zen-padding)',
          paddingLeft: 'var(--zen-padding)',
          paddingRight: 'var(--zen-padding)',
          paddingBottom: barHidden ? 'var(--zen-padding)' : 0
        }}
      >
        <div className="relative min-h-0 flex-1">
          <ContentArea state={state} ui={ui} />
        </div>
      </main>
      {!barHidden && <PhoneBar state={state} ui={ui} />}
      {ui.drawerOpen && (
        <div className="absolute inset-0 z-40" onPointerDown={() => closeDrawer()}>
          <div
            className={cn(
              'zen-drawer absolute inset-y-0 flex w-[min(320px,calc(100%-56px))] p-2',
              side === 'left' ? 'left-0 zen-drawer-left' : 'right-0 zen-drawer-right'
            )}
            style={{
              paddingTop: 'calc(var(--zen-inset-top) + 8px)',
              paddingBottom: 'calc(var(--zen-inset-bottom) + 8px)'
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Sidebar state={state} isDark={isDark} floating hideNav className="w-full" />
          </div>
        </div>
      )}
      <PhoneToasts ui={ui} barVisible={!barHidden} />
      {onboarding && <Onboarding state={state} />}
    </div>
  )
}

/** Back · address pill · new tab · tabs · menu. Swipe the pill sideways to change spaces. */
function PhoneBar({ state, ui }: { state: UIState; ui: UiState }): JSX.Element {
  const tab = activeTab(state)
  const space = activeSpace(state)
  const count = tabsOf(state, space).length + essentialsFor(state, space).length
  const url = tab ? displayUrl(tab.url) : ''
  const secure = tab?.url.startsWith('https://')
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null)

  return (
    <nav
      className="zen-phone-bar relative z-30 flex items-center gap-1 px-2 pt-1.5"
      style={{ paddingBottom: 'calc(var(--zen-inset-bottom) + 6px)' }}
    >
      <button
        type="button"
        className="zen-toolbar-button h-11 w-11"
        aria-label="Back"
        disabled={!tab?.canGoBack}
        onClick={() => tab && run('tab.back', { tabId: tab.id })}
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <button
        type="button"
        className="zen-phone-pill flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--zen-element-bg)] px-3.5 text-left active:bg-[var(--zen-element-bg-hover)]"
        style={{ touchAction: 'pan-y' }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return
          swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
        }}
        onPointerUp={(e) => {
          const start = swipe.current
          swipe.current = null
          if (!start || start.id !== e.pointerId) return
          const dx = e.clientX - start.x
          const dy = e.clientY - start.y
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            // A horizontal flick changes space; the click that follows must not open the URL bar.
            e.preventDefault()
            e.currentTarget.dataset.swiped = 'true'
            run(dx < 0 ? 'space.next' : 'space.prev', undefined)
          }
        }}
        onClick={(e) => {
          if (e.currentTarget.dataset.swiped) {
            delete e.currentTarget.dataset.swiped
            return
          }
          void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, { attached: true })
        }}
      >
        {tab ? <Favicon tab={tab} size={16} /> : <Search className="h-4 w-4 shrink-0 opacity-60" />}
        <span
          className={cn('min-w-0 flex-1 truncate text-[14px]', !url && 'text-[var(--zen-muted)]')}
        >
          {url || 'Search or enter address'}
        </span>
        {url && secure && <Lock className="h-3.5 w-3.5 shrink-0 opacity-50" />}
        {state.spaces.length > 1 && (
          <span className="max-w-[64px] shrink-0 truncate text-[11px] text-[var(--zen-muted)]">
            {space.icon || space.name}
          </span>
        )}
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-11 w-11"
        aria-label="New tab"
        onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
        onContextMenu={(e) => {
          e.preventDefault()
          run('newtab.contextMenu', undefined)
        }}
      >
        <Plus className="h-5 w-5" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-11 w-11"
        aria-label={`Tabs (${count})`}
        onClick={() => (ui.drawerOpen ? closeDrawer() : void openDrawer(tab?.id ?? null))}
      >
        <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-[6px] border-2 border-current px-1 text-[11px] font-semibold leading-none">
          {count > 99 ? '∞' : count}
        </span>
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-11 w-11"
        aria-label="Menu"
        onClick={() => run('app.menu', undefined)}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
    </nav>
  )
}

function PhoneToasts({ ui, barVisible }: { ui: UiState; barVisible: boolean }): JSX.Element | null {
  if (ui.toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-50 flex flex-col items-center gap-1 px-4"
      style={{ bottom: `calc(var(--zen-inset-bottom) + ${barVisible ? 64 : 12}px)` }}
    >
      {ui.toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'zen-toast zen-panel px-3.5 py-2 text-[13px]',
            t.kind === 'error' && 'text-red-500'
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
