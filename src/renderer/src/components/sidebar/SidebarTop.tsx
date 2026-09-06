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
  // Linux/Windows: Zen draws the window buttons at the top of the sidebar (macOS uses the
  // native traffic lights, which need left padding instead). Mobile hosts have neither.
  const showControls = state.capabilities.windowControls && !isMac && !state.window.fullscreen
  const reserveTitleRow = showControls || isMac
  return (
    <div className={cn('zen-drag flex flex-col gap-1 px-2', reserveTitleRow ? 'pt-1.5' : 'pt-2')}>
      {reserveTitleRow && (
        <div className={cn('flex h-8 items-center justify-end', isMac && 'pl-16')}>
          {showControls && !compact && <WindowControls />}
          {showControls && compact && <WindowControls compact />}
        </div>
      )}
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
