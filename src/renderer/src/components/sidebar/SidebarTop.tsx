import type { JSX } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Lock,
  MoreHorizontal,
  RotateCw,
  Search,
  X
} from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { displayUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { openUrlbar } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { WindowControls } from '../WindowControls'

interface Props {
  state: UIState
  tab: Tab | null
  compact: boolean
  /** Single-toolbar layout puts navigation + the address pill inside the sidebar. */
  showToolbar: boolean
}

export function SidebarTop({ state, tab, compact, showToolbar }: Props): JSX.Element {
  const isMac = state.platform === 'darwin'
  const controlsInSidebar = !state.window.fullscreen && state.settings.sidebarSide === 'left'
  return (
    <div className="zen-drag flex flex-col gap-1 px-2 pt-1.5">
      <div className={cn('flex h-8 items-center', isMac ? 'justify-end pl-16' : 'justify-end')}>
        {!compact && !isMac && controlsInSidebar && <WindowControls />}
        {!compact && isMac && controlsInSidebar && <span className="flex-1" />}
        {!controlsInSidebar && <span className="flex-1" />}
      </div>
      {showToolbar && <NavRow state={state} tab={tab} compact={compact} />}
    </div>
  )
}

export function NavRow({
  state,
  tab,
  compact,
  className
}: {
  state: UIState
  tab: Tab | null
  compact: boolean
  className?: string
}): JSX.Element {
  const url = tab ? displayUrl(tab.url) : ''
  const secure = tab?.url.startsWith('https://')
  return (
    <div className={cn('zen-no-drag flex items-center gap-0.5', compact && 'flex-col', className)}>
      <button
        type="button"
        className="zen-toolbar-button"
        title="Back (Alt+←)"
        disabled={!tab?.canGoBack}
        onClick={() => tab && run('tab.back', { tabId: tab.id })}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button"
        title="Forward (Alt+→)"
        disabled={!tab?.canGoForward}
        onClick={() => tab && run('tab.forward', { tabId: tab.id })}
      >
        <ArrowRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button"
        title={tab?.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)'}
        disabled={!tab}
        onClick={() =>
          tab &&
          (tab.loading ? run('tab.stop', { tabId: tab.id }) : run('tab.reload', { tabId: tab.id }))
        }
      >
        {tab?.loading ? <X className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
      </button>
      {!compact && (
        <button
          type="button"
          className="group/pill mx-0.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-[var(--zen-element-bg)] px-2.5 text-left hover:bg-[var(--zen-element-bg-hover)]"
          title={tab?.url ?? 'Search or enter address'}
          onClick={() =>
            void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, {
              attached: state.settings.urlbarBehavior !== 'always-float'
            })
          }
        >
          {url ? (
            secure ? (
              <Lock className="h-3 w-3 shrink-0 opacity-60" />
            ) : (
              <Search className="h-3 w-3 shrink-0 opacity-60" />
            )
          ) : (
            <Search className="h-3 w-3 shrink-0 opacity-60" />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12.5px]',
              !url && 'text-[var(--zen-muted)]'
            )}
          >
            {url || 'Search or enter address'}
          </span>
          {url && (
            <span
              role="button"
              tabIndex={-1}
              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] group-hover/pill:flex"
              title="Copy URL (Ctrl+Shift+C)"
              onClick={(e) => {
                e.stopPropagation()
                if (tab) run('tab.copyUrl', { tabId: tab.id })
              }}
            >
              <Copy className="h-3 w-3" />
            </span>
          )}
        </button>
      )}
      <button
        type="button"
        className="zen-toolbar-button"
        title="Menu"
        onClick={() => run('app.menu', undefined)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </div>
  )
}
