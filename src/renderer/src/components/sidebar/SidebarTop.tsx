import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Copy,
  File,
  Info,
  Lock,
  MoreHorizontal,
  RotateCw,
  Search,
  Sparkles,
  TriangleAlert,
  VenetianMask,
  X
} from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { securityIndicator, type IndicatorState } from '@shared/siteInfo'
import { addressParts, displayUrl, fullUrl, getDomain, pillText } from '@shared/url'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { run } from '@renderer/lib/api'
import { isPrivateWindow } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { APP_MENU_EVENT, hint, openAppMenu } from '@renderer/lib/shortcuts'
import { openOverlay, openUrlbar, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { StarChip } from '../bookmarks/StarChip'
import { useBookmarkTree } from '../bookmarks/tree'
import { ToolbarActions } from '../extensions/ToolbarActions'
import { useLongPress } from '../phone/useLongPress'
import { PillChip } from '../urlbar/PillChip'
import { WindowControls } from '../WindowControls'
import { ZoomChip } from '../zoom/ZoomChip'
import { DownloadButton } from '../downloads/DownloadButton'
import { downloadButtonVisible, downloadsUi } from '@renderer/lib/downloads'

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
  // An internal page's address that the pill cannot fit gives way to the page's title, as the
  // phone pill names Zenium's own pages (v2 §10.1): `pillText`, from the field's width against
  // the address at its natural width (the probe span, drawn invisibly without truncation).
  const pill = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLSpanElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const fits = useAddressFits(pill, field, probe, !compact)
  const text = tab ? pillText(tab.url, shown, fits) : ''
  const address = addressParts(text)
  // What the site icon says (derived in the core's site-information module, drawn here).
  const indicator = securityIndicator(
    tab?.url ?? '',
    tab?.errorCode ?? null,
    tab?.certificateError ?? null
  )
  const isPrivate = isPrivateWindow(state)
  const isWebPage = Boolean(tab && /^https?:/.test(tab.url))
  const isReader = Boolean(tab?.url.startsWith('zen://reader'))
  const boosted = Boolean(
    tab && isWebPage && state.boosts.some((b) => b.domain === getDomain(tab.url) && b.enabled)
  )
  const row = useRef<HTMLDivElement>(null)
  const rowWidth = useElementWidth(row)
  const downloadsUiState = downloadsUi.use()
  // What the chips have open, for their `aria-expanded`.
  const siteInfoOpen = uiStore.use((s) => s.siteInfoOpen)
  const boostsOpen = uiStore.use((s) => s.overlay === 'boosts')
  // A popup (`window.open` with features) has Chrome's read-only location bar: the address and
  // its chips show where the page is, but nothing can be typed into it.
  const readOnly = state.window.chrome === 'popup'
  const openField = (): void => {
    if (readOnly) return
    void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, {
      attached: state.settings.urlbarBehavior !== 'always-float'
    })
  }
  const tree = useBookmarkTree(state)
  // The star stays on a site and on an internal page whose registry entry keeps it (Chrome shows
  // it on chrome://settings; the new tab page hides it) – `pill.showStar`, v2 §10.1.
  const starred = Boolean(tab && (isWebPage || internalPageOf(tab.url)?.pill.showStar))
  const bookmarked = Boolean(tab && starred && tree.hasUrl(tab.url))
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
    <div
      ref={row}
      className={cn('zen-no-drag flex items-center gap-0.5', compact && 'flex-col', className)}
      // The bar the extension popovers and the downloads bubble hang from (v2 §9.20): flush
      // under it, aligned by half. (Its token family is the window's, from the `data-surface`
      // on SidebarTop's root.)
      data-bar={compact ? undefined : ''}
      data-zen-nav-row
    >
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
        data-zen-menu="reload"
        data-zen-menu-tab={tab?.id}
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
          ref={pill}
          role="group"
          aria-label="Address"
          className={cn(
            'zen-squircle zen-pill group/pill relative mx-0.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-[var(--zen-element-bg)] px-2.5 text-left',
            !readOnly && 'hover:bg-[var(--zen-element-bg-hover)]'
          )}
          // The tooltip carries the whole address – the user-facing `zenium://` form for an
          // internal page (§10.1: `zen://` never shows), and the address behind a title.
          title={(tab && fullUrl(tab.url)) || 'Search or enter address'}
          data-zen-menu="urlpill"
          data-zen-menu-tab={tab?.id}
          data-readonly={readOnly || undefined}
          onClick={openField}
        >
          <button
            type="button"
            className={cn(
              'flex h-full min-w-0 flex-1 items-center text-left',
              readOnly && 'cursor-default'
            )}
            aria-readonly={readOnly || undefined}
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
              ref={field}
              className={cn(
                'min-w-0 flex-1 truncate text-[12.5px]',
                !url && 'text-[var(--zen-muted)]'
              )}
              data-reads={url ? (text === shown ? 'address' : 'title') : undefined}
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
          {/* The address at its natural width, for `useAddressFits`; out of flow, never seen. */}
          <span
            ref={probe}
            aria-hidden="true"
            className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-[12.5px]"
            data-pill-probe
          >
            {shown}
          </span>
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
            Every chip after the address carries `zen-pill-chip`: a pill under 130 px drops them
            all for the address (the container query on `.zen-pill`), the site icon stays.
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
                  'zen-pill-chip flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
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
                  'zen-pill-chip h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
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
                className="zen-pill-chip zen-pill-extra hidden h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] group-hover/pill:flex group-focus-within/chips:flex"
                onActivate={() => tab && run('tab.copyUrl', { tabId: tab.id })}
              >
                <Copy className="h-3 w-3" />
              </PillChip>
            )}
            {tab && <ZoomChip state={state} tab={tab} />}
            {tab && starred && (
              <StarChip
                tab={tab}
                filled={bookmarked}
                title={hint(
                  bookmarked ? 'Edit bookmark' : 'Bookmark this tab',
                  state,
                  'bookmark.add'
                )}
              />
            )}
          </span>
        </div>
      )}
      <DownloadButton state={state} activeTabId={tab?.id ?? null} />
      <ToolbarActions
        state={state}
        rowWidth={compact ? null : rowWidth}
        // The downloads button joins the fixed set while it is in the row.
        fixedButtons={FIXED_BUTTONS + (downloadButtonVisible(state, downloadsUiState) ? 1 : 0)}
        compact={compact}
      />
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
 * Whether the address at its natural width (`probe`) fits the width the pill gives its field
 * (`field`): measured before the first paint and again whenever either changes size – the
 * sidebar resized, a chip come or gone, the tab moved to another section. Held still while the
 * pointer or the keyboard is on the pill: the hover-only chips narrow the field for the hover's
 * duration, and the text must not swap under the pointer – it truncates then, as every address
 * does. The observer's next delivery after the hover ends measures the rest layout again.
 * `mounted` says the pill is in the row (the compact sidebar has none): its change rebinds the
 * observer to the pill the row has now.
 */
function useAddressFits(
  pill: RefObject<HTMLElement | null>,
  field: RefObject<HTMLElement | null>,
  probe: RefObject<HTMLElement | null>,
  mounted: boolean
): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const slot = field.current
    const text = probe.current
    if (!mounted || !slot || !text) return
    // Fractional widths: a text 0.3 px wider than its box already draws the ellipsis.
    const measure = (): void => {
      if (pill.current?.matches(':hover, :focus-within')) return
      setFits(text.getBoundingClientRect().width <= slot.getBoundingClientRect().width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(slot)
    observer.observe(text)
    return () => observer.disconnect()
  }, [pill, field, probe, mounted])
  return fits
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
