import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Copy,
  File,
  Info,
  Lock,
  MoreHorizontal,
  Puzzle,
  RotateCw,
  Search,
  Sparkles,
  TriangleAlert,
  VenetianMask,
  X
} from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { securityIndicator, type IndicatorState } from '@shared/siteInfo'
import { addressParts, displayUrl, fullUrl, getDomain } from '@shared/url'
import { run } from '@renderer/lib/api'
import { isPrivateWindow } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { APP_MENU_EVENT, hint, openAppMenu } from '@renderer/lib/shortcuts'
import { openOverlay, openUrlbar, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { StarChip } from '../bookmarks/StarChip'
import { useBookmarkTree } from '../bookmarks/tree'
import { useLongPress } from '../phone/useLongPress'
import { PillChip } from '../urlbar/PillChip'
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
  const fullscreen = state.window.fullscreen
  // Linux: Zen draws the window buttons at the top of the sidebar. macOS uses the native
  // traffic lights, which need left padding instead, and Windows draws native buttons over the
  // window's top corner, so the row stays clear for them. Mobile hosts have none of these.
  const overlay = state.capabilities.windowControlsOverlay && !fullscreen
  const showControls = state.capabilities.windowControls && !overlay && !isMac && !fullscreen
  const reserveTitleRow = showControls || isMac || overlay
  return (
    // A window surface (design language v2 §9.29): the pill and its chips draw in the window family.
    <div
      className={cn('zen-drag flex flex-col gap-1 px-2', reserveTitleRow ? 'pt-1.5' : 'pt-2')}
      data-surface="window"
    >
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
  // The address at rest elides the scheme and `www.` (Chrome); the full URL shows while the
  // pointer or the keyboard is on the address, or always with the "Always show full URLs" setting.
  const [revealed, setRevealed] = useState(false)
  const shown = tab ? (state.settings.showFullUrls || revealed ? fullUrl(tab.url) : url) : ''
  const address = addressParts(shown)
  // What the site icon says (derived in the core's site-information module, drawn here).
  const indicator = securityIndicator(tab?.url ?? '', tab?.errorCode ?? null)
  const isPrivate = isPrivateWindow(state)
  const isWebPage = Boolean(tab && /^https?:/.test(tab.url))
  const isReader = Boolean(tab?.url.startsWith('zen://reader'))
  const boosted = Boolean(
    tab && isWebPage && state.boosts.some((b) => b.domain === getDomain(tab.url) && b.enabled)
  )
  const extensions = state.extensions.filter((e) => e.enabled && !e.error && e.popup)
  // What the chips have open, for their `aria-expanded`.
  const siteInfoOpen = uiStore.use((s) => s.siteInfoOpen)
  const boostsOpen = uiStore.use((s) => s.overlay === 'boosts')
  const openField = (): void =>
    void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, {
      attached: state.settings.urlbarBehavior !== 'always-float'
    })
  const tree = useBookmarkTree(state)
  const bookmarked = Boolean(tab && isWebPage && tree.hasUrl(tab.url))
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Alt+F / F10: the menu opens from this button with the keyboard on it, so Escape closes
    // the menu and leaves the focus here (design language v2 §9.22).
    const fromKeyboard = (e: Event): void => {
      const button = menuButton.current
      if (!button || e.defaultPrevented || button.offsetParent === null) return
      e.preventDefault()
      button.focus()
      openAppMenu(button, true)
    }
    window.addEventListener(APP_MENU_EVENT, fromKeyboard)
    return () => window.removeEventListener(APP_MENU_EVENT, fromKeyboard)
  }, [])
  return (
    <div className={cn('zen-no-drag flex items-center gap-0.5', compact && 'flex-col', className)}>
      <NavigationButton
        tab={tab}
        title={hint('Back', state, 'nav.back')}
        enabled={Boolean(tab?.canGoBack)}
        command="tab.back"
      >
        <ArrowLeft className="h-4 w-4" />
      </NavigationButton>
      <NavigationButton
        tab={tab}
        title={hint('Forward', state, 'nav.forward')}
        enabled={Boolean(tab?.canGoForward)}
        command="tab.forward"
      >
        <ArrowRight className="h-4 w-4" />
      </NavigationButton>
      <button
        type="button"
        className="zen-toolbar-button"
        title={tab?.loading ? 'Stop (Esc)' : hint('Reload', state, 'nav.reload')}
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
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center text-left"
            onMouseEnter={() => setRevealed(true)}
            onMouseLeave={() => setRevealed(false)}
            onFocus={() => setRevealed(true)}
            onBlur={() => setRevealed(false)}
            onKeyDown={(e) => {
              // Ctrl+C on the address copies the full URL, scheme included, as plain text.
              if (tab && url && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                e.preventDefault()
                run('tab.copyUrl', { tabId: tab.id, markdown: false })
              }
            }}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[12.5px]',
                !url && 'text-[var(--zen-muted)]'
              )}
            >
              {url ? (
                <>
                  {address.site}
                  {address.rest && <span className="opacity-70">{address.rest}</span>}
                </>
              ) : (
                'Search or enter address'
              )}
            </span>
          </button>
          {/*
            Chrome's "Not secure" text before the address of an http page (or of a certificate
            error's page, in the danger ink), drawn between the site icon and the address; a
            narrow pill drops it before the address (see the container query on `.zen-pill`).
          */}
          {indicator.label && url && tab && (
            <span
              className={cn(
                'zen-pill-label order-[-1] shrink-0 text-[11.5px]',
                indicator.state === 'certificate-error' ? 'text-[var(--zen-danger)]' : 'opacity-70'
              )}
              data-indicator={indicator.state}
            >
              {indicator.label}
            </span>
          )}
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
                title={indicator.title}
                popup="dialog"
                expanded={siteInfoOpen}
                data-indicator={indicator.state}
                className={cn(
                  'order-first -ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] hover:opacity-100',
                  indicator.state === 'certificate-error' && 'text-[var(--zen-danger)] opacity-100'
                )}
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
                <IndicatorGlyph state={indicator.state} scheme={tab.url.split(':')[0] ?? ''} />
              </PillChip>
            ) : (
              <Search className="order-first h-3 w-3 shrink-0 opacity-60" />
            )}
            {tab && (tab.readerable || isReader) && (
              <PillChip
                label="Reader View"
                title={hint(
                  isReader ? 'Exit Reader View' : 'Enter Reader View',
                  state,
                  'page.readerMode'
                )}
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
                title={hint('Copy URL', state, 'tab.copyUrl')}
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
      {!compact && extensions.slice(0, 4).map((ext) => <ExtensionButton key={ext.id} ext={ext} />)}
      <button
        ref={menuButton}
        type="button"
        className="zen-toolbar-button"
        title={hint('Menu', state, 'menu.app')}
        aria-haspopup="menu"
        onClick={() => openAppMenu(menuButton.current)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </div>
  )
}

/**
 * The site icon's glyph for an indicator state (the state itself is derived in the core, see
 * `securityIndicator`): the lock for https; Chrome's info circle for http, which the "Not
 * secure" text goes with; the warning triangle for a certificate error; the page glyph for
 * `file:` and Zenium's own pages; the info circle where nothing more is known.
 */
function IndicatorGlyph({ state, scheme }: { state: IndicatorState; scheme: string }): JSX.Element {
  switch (state) {
    case 'secure':
      return <Lock className="h-3 w-3" />
    case 'certificate-error':
      return <TriangleAlert className="h-3 w-3" />
    case 'internal':
      return <File className="h-3 w-3" />
    case 'local':
      return scheme === 'file' ? <File className="h-3 w-3" /> : <Info className="h-3 w-3" />
    case 'empty':
      return <Search className="h-3 w-3" />
    default:
      return <Info className="h-3 w-3" />
  }
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
      onContextMenu={(e) => {
        e.preventDefault()
        run('extension.actionContextMenu', { id: ext.id, x: e.clientX, y: e.clientY })
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
