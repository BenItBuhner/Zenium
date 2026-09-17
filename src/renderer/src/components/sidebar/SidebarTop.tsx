import type { JSX, ReactNode } from 'react'
import { useRef } from 'react'
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Copy,
  Lock,
  MoreHorizontal,
  Puzzle,
  RotateCw,
  Search,
  Sparkles,
  VenetianMask,
  X
} from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { displayUrl, getDomain } from '@shared/url'
import { run } from '@renderer/lib/api'
import { isPrivateWindow } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { openOverlay, openUrlbar } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useLongPress } from '../phone/useLongPress'
import { blockedPopupsOf, openBlockedPopups } from '@renderer/lib/security'
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
  const isPrivate = isPrivateWindow(state)
  const isWebPage = Boolean(tab && /^https?:/.test(tab.url))
  const isReader = Boolean(tab?.url.startsWith('zen://reader'))
  const boosted = Boolean(
    tab && isWebPage && state.boosts.some((b) => b.domain === getDomain(tab.url) && b.enabled)
  )
  const extensions = state.extensions.filter((e) => e.enabled && !e.error && e.popup)
  const blocked = blockedPopupsOf(state, tab?.id)
  return (
    <div className={cn('zen-no-drag flex items-center gap-0.5', compact && 'flex-col', className)}>
      <NavigationButton
        tab={tab}
        title="Back (Alt+←)"
        enabled={Boolean(tab?.canGoBack)}
        command="tab.back"
      >
        <ArrowLeft className="h-4 w-4" />
      </NavigationButton>
      <NavigationButton
        tab={tab}
        title="Forward (Alt+→)"
        enabled={Boolean(tab?.canGoForward)}
        command="tab.forward"
      >
        <ArrowRight className="h-4 w-4" />
      </NavigationButton>
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
          className="zen-squircle group/pill mx-0.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-[var(--zen-element-bg)] px-2.5 text-left hover:bg-[var(--zen-element-bg-hover)]"
          title={tab?.url ?? 'Search or enter address'}
          onClick={() =>
            void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, {
              attached: state.settings.urlbarBehavior !== 'always-float'
            })
          }
        >
          {isPrivate ? (
            <VenetianMask className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : url && tab ? (
            // The site icon: connection state at a glance, site information on click.
            <span
              role="button"
              tabIndex={-1}
              className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] hover:opacity-100"
              title={secure ? 'Connection is secure · Site information' : 'Site information'}
              aria-label="Site information"
              onClick={(e) => {
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                void openSiteInfo(tab, { x: r.left, y: r.top, width: r.width, height: r.height })
              }}
            >
              {secure ? <Lock className="h-3 w-3" /> : <Search className="h-3 w-3" />}
            </span>
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
          {tab && (tab.readerable || isReader) && (
            <span
              role="button"
              tabIndex={-1}
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
                isReader && 'text-[var(--zen-accent)] opacity-100'
              )}
              title={isReader ? 'Exit Reader View (Ctrl+Alt+R)' : 'Enter Reader View (Ctrl+Alt+R)'}
              onClick={(e) => {
                e.stopPropagation()
                run('reader.toggle', { tabId: tab.id })
              }}
            >
              <BookOpenText className="h-3.5 w-3.5" />
            </span>
          )}
          {tab && blocked.length > 0 && (
            <span
              role="button"
              tabIndex={-1}
              className="zen-animate-pop flex h-5 shrink-0 items-center gap-1 rounded-md bg-[var(--zen-element-bg-hover)] px-1 text-[var(--zen-accent)] hover:bg-[var(--zen-element-bg-active)]"
              title={blocked.length === 1 ? 'Pop-up blocked' : `${blocked.length} pop-ups blocked`}
              onClick={(e) => {
                e.stopPropagation()
                openBlockedPopups(tab.id, e.currentTarget.getBoundingClientRect())
              }}
            >
              <AppWindow className="h-3.5 w-3.5" />
              {blocked.length > 1 && (
                <span className="text-[10.5px] font-semibold tabular-nums">{blocked.length}</span>
              )}
            </span>
          )}
          {tab && isWebPage && !isPrivate && (
            <span
              role="button"
              tabIndex={-1}
              className={cn(
                'h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
                boosted
                  ? 'flex text-[var(--zen-accent)] opacity-100'
                  : 'hidden group-hover/pill:flex'
              )}
              title={boosted ? 'Edit Boost for this site' : 'Boost this site'}
              onClick={(e) => {
                e.stopPropagation()
                void openOverlay('boosts', tab.id)
              }}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </span>
          )}
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
      {!compact && extensions.slice(0, 4).map((ext) => <ExtensionButton key={ext.id} ext={ext} />)}
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

/**
 * Back or forward: a click navigates one step; press-and-hold (about 400 ms, released) or a
 * right click lists the tab's back/forward stack instead, like Firefox's buttons.
 */
function NavigationButton({
  tab,
  title,
  enabled,
  command,
  children
}: {
  tab: Tab | null
  title: string
  enabled: boolean
  command: 'tab.back' | 'tab.forward'
  children: ReactNode
}): JSX.Element {
  const press = useLongPress(() => tab && run('tab.navigationMenu', { tabId: tab.id }))
  return (
    <button
      type="button"
      className="zen-toolbar-button"
      title={title}
      disabled={!enabled}
      {...press.handlers}
      onClick={() => {
        if (press.swallowsClick() || !tab) return
        run(command, { tabId: tab.id })
      }}
    >
      {children}
    </button>
  )
}

/** Browser-action button of a loaded extension; its popup opens anchored below the button. */
function ExtensionButton({ ext }: { ext: UIState['extensions'][number] }): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      className="zen-toolbar-button"
      title={ext.name}
      onClick={() => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        run('extension.openPopup', {
          id: ext.id,
          anchor: { x: r.left, y: r.top, width: r.width, height: r.height }
        })
      }}
    >
      {ext.icon ? (
        <img src={ext.icon} alt="" className="h-4 w-4 rounded-[3px]" draggable={false} />
      ) : (
        <Puzzle className="h-4 w-4" />
      )}
    </button>
  )
}
