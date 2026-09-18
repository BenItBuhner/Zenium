import type { JSX, ReactNode } from 'react'
import { useRef } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Copy,
  Lock,
  MoreHorizontal,
  RotateCw,
  Search,
  Sparkles,
  VenetianMask,
  X
} from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { displayUrl, getDomain } from '@shared/url'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { run } from '@renderer/lib/api'
import { isPrivateWindow } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { openOverlay, openUrlbar, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { StarChip } from '../bookmarks/StarChip'
import { useBookmarkTree } from '../bookmarks/tree'
import { ToolbarActions } from '../extensions/ToolbarActions'
import { useLongPress } from '../phone/useLongPress'
import { PillChip } from '../urlbar/PillChip'
import { WindowControls } from '../WindowControls'

/** Back, forward, reload, the puzzle piece and the menu: always in the row, never folded. */
const FIXED_BUTTONS = 5

interface Props {
  state: UIState
  tab: Tab | null
  compact: boolean
  /** Single-toolbar layout puts navigation + the address pill inside the sidebar. */
  showToolbar: boolean
}

export function SidebarTop({ state, tab, compact, showToolbar }: Props): JSX.Element {
  const isMac = state.platform === 'darwin'
  const fullscreen = state.window.fullscreen
  // Linux: Zen draws the window buttons at the top of the sidebar. macOS uses the native
  // traffic lights, which need left padding instead, and Windows draws native buttons over the
  // window's top corner, so the row stays clear for them. Mobile hosts have none of these.
  const overlay = state.capabilities.windowControlsOverlay && !fullscreen
  const showControls = state.capabilities.windowControls && !overlay && !isMac && !fullscreen
  const reserveTitleRow = showControls || isMac || overlay
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
  const row = useRef<HTMLDivElement>(null)
  const rowWidth = useElementWidth(row)
  // What the chips have open, for their `aria-expanded`.
  const siteInfoOpen = uiStore.use((s) => s.siteInfoOpen)
  const boostsOpen = uiStore.use((s) => s.overlay === 'boosts')
  const openField = (): void =>
    void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, {
      attached: state.settings.urlbarBehavior !== 'always-float'
    })
  const tree = useBookmarkTree(state)
  const bookmarked = Boolean(tab && isWebPage && tree.hasUrl(tab.url))
  return (
    <div
      ref={row}
      className={cn('zen-no-drag flex items-center gap-0.5', compact && 'flex-col', className)}
      // The bar the extension popovers hang from (v2 §9.20): flush under it, aligned by half.
      data-bar={compact ? undefined : ''}
      // A window surface (v2 §9.29): what sits in it – the extension actions and their badges –
      // draws in the theme's foreground and accent, never in a page token.
      data-surface="window"
    >
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
        /*
          The pill is a group, not a button: the address and each chip inside it are buttons of
          their own, so every one is in the tab order and a screen reader gets a node for each
          (a button's descendants would collapse into one). A click on the pill itself – its
          padding, the address – opens the URL bar; the chips stop their clicks. The address
          comes first in the DOM so Tab reaches the field before its chips (design language v2
          §9.22); the site icon is drawn ahead of it with `order-first`.
        */
        <div
          role="group"
          aria-label="Address"
          className="zen-squircle zen-pill group/pill mx-0.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-[var(--zen-element-bg)] px-2.5 text-left hover:bg-[var(--zen-element-bg-hover)]"
          title={tab?.url ?? 'Search or enter address'}
          onClick={openField}
        >
          <button type="button" className="flex h-full min-w-0 flex-1 items-center text-left">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[12.5px]',
                !url && 'text-[var(--zen-muted)]'
              )}
            >
              {url || 'Search or enter address'}
            </span>
          </button>
          {/*
            The chips, in one focus scope of their own (`display: contents`, so they stay flex
            items of the pill): the hover-only Boost and Copy chips also show while the keyboard
            is on one of the chips, so Tab can reach them – but not while the address itself is
            focused, when they would squeeze the address out of a narrow pill. A `:focus-within`
            scope rather than `:has(:focus-visible)`: Chromium blocks a Tab whose target is
            unfocusable in the instant between blurring the old chip and focusing the next, and
            only `:focus-within` on their common ancestor holds through that instant.
          */}
          <span className="contents group/chips">
            {isPrivate ? (
              <VenetianMask className="order-first h-3.5 w-3.5 shrink-0 opacity-70" />
            ) : url && tab ? (
              // The site icon: connection state at a glance, site information on click.
              <PillChip
                label="Site information"
                title={secure ? 'Connection is secure · Site information' : 'Site information'}
                popup="dialog"
                expanded={siteInfoOpen}
                className="order-first -ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] hover:opacity-100"
                onActivate={(e) => {
                  const chip = e.currentTarget
                  const r = chip.getBoundingClientRect()
                  void openSiteInfo(
                    tab,
                    { x: r.left, y: r.top, width: r.width, height: r.height },
                    chip
                  )
                }}
              >
                {secure ? <Lock className="h-3 w-3" /> : <Search className="h-3 w-3" />}
              </PillChip>
            ) : (
              <Search className="order-first h-3 w-3 shrink-0 opacity-60" />
            )}
            {tab && (tab.readerable || isReader) && (
              <PillChip
                label="Reader View"
                title={
                  isReader ? 'Exit Reader View (Ctrl+Alt+R)' : 'Enter Reader View (Ctrl+Alt+R)'
                }
                pressed={isReader}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
                  isReader && 'text-[var(--zen-accent)] opacity-100'
                )}
                onActivate={() => run('reader.toggle', { tabId: tab.id })}
              >
                <BookOpenText className="h-3.5 w-3.5" />
              </PillChip>
            )}
            {tab && isWebPage && !isPrivate && (
              <PillChip
                label={boosted ? 'Edit Boost for this site' : 'Boost this site'}
                title={boosted ? 'Edit Boost for this site' : 'Boost this site'}
                popup="dialog"
                expanded={boostsOpen}
                className={cn(
                  'h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
                  boosted
                    ? 'flex text-[var(--zen-accent)] opacity-100'
                    : 'zen-pill-extra hidden group-hover/pill:flex group-focus-within/chips:flex'
                )}
                onActivate={() => void openOverlay('boosts', tab.id)}
              >
                <Sparkles className="h-3.5 w-3.5" />
              </PillChip>
            )}
            {url && (
              <PillChip
                label="Copy URL"
                title="Copy URL (Ctrl+Shift+C)"
                className="zen-pill-extra hidden h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] group-hover/pill:flex group-focus-within/chips:flex"
                onActivate={() => tab && run('tab.copyUrl', { tabId: tab.id })}
              >
                <Copy className="h-3 w-3" />
              </PillChip>
            )}
            {tab && isWebPage && <StarChip tab={tab} filled={bookmarked} />}
          </span>
        </div>
      )}
      <ToolbarActions
        state={state}
        rowWidth={compact ? null : rowWidth}
        fixedButtons={FIXED_BUTTONS}
        compact={compact}
      />
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
