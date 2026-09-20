import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  ALargeSmall,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Copy,
  File,
  Info,
  Languages,
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
import {
  addressParts,
  displayUrl,
  fullUrl,
  getDomain,
  isWebPageUrl,
  presentedUrl
} from '@shared/url'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { run } from '@renderer/lib/api'
import { chromeDropStore } from '@renderer/lib/dnd'
import { extensionPageChrome } from '@renderer/lib/extensions/pages'
import { dropStore } from '@renderer/lib/drag'
import { blockedPopupsOf, closeBlockedPopups, openBlockedPopups } from '@renderer/lib/security'
import { isPrivateWindow } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { APP_MENU_EVENT, hint, openAppMenu } from '@renderer/lib/shortcuts'
import { barStateOf, isTranslating, translateStateOf } from '@renderer/lib/translate'
import {
  closeReaderPreferences,
  openOverlay,
  openReaderPreferences,
  openUrlbar,
  uiStore
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { AutofillChip } from '../autofill/AutofillChip'
import { StarChip } from '../bookmarks/StarChip'
import { useBookmarkTree } from '../bookmarks/tree'
import { ExtensionIcon } from '../extensions/ExtensionIcon'
import { ToolbarActions } from '../extensions/ToolbarActions'
import { useLongPress } from '../phone/useLongPress'
import { BlockedChip } from '../urlbar/BlockedChip'
import { PillChip } from '../urlbar/PillChip'
import { TOOLBAR_STROKE } from '../v2/controls'
import { WindowControls } from '../WindowControls'
import { ZoomChip } from '../zoom/ZoomChip'
import { DownloadButton } from '../downloads/DownloadButton'
import { MediaHubButton } from '../media/MediaHubButton'
import { downloadButtonVisible, downloadsUi } from '@renderer/lib/downloads'
import { mediaHubVisible } from '@renderer/lib/mediaHub'

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
  const address = addressParts(shown)
  // What the site icon says (derived in the core's site-information module, drawn here).
  const indicator = securityIndicator(
    tab?.url ?? '',
    tab?.errorCode ?? null,
    tab?.certificateError ?? null
  )
  const isPrivate = isPrivateWindow(state)
  // A page of the web gets the site chips; an extension page is not one, whatever origin the
  // Android runtime serves it from (v2 §10.1 applied to extension pages): its icon takes the
  // site icon's place, titled for what it is, and no lock, shield, reader or translation chip.
  const isWebPage = Boolean(tab && isWebPageUrl(tab.url))
  const extension = tab ? extensionPageChrome(tab.url, state.extensions) : null
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
  const blockedOpen = uiStore.use(
    (s) => s.blockedPopupsPanel !== null && s.blockedPopupsPanel.tabId === tab?.id
  )
  const readerPrefsOpen = uiStore.use(
    (s) => s.readerPreferences !== null && s.readerPreferences.tabId === tab?.id
  )
  // A popup (`window.open` with features) has Chrome's read-only location bar: the address and
  // its chips show where the page is, but nothing can be typed into it. (An app window draws
  // its title bar in place of this row, `app/AppTitleBar.tsx`; should the row ever stand in for
  // it, the address stays read-only there too.)
  const readOnly = state.window.chrome === 'popup' || state.window.chrome === 'app'
  // An address or text dragged over the pill goes to the tab as typed (lib/dnd.ts, Chrome's
  // paste and go): the pill shows it will take the drop (§9.4) – or, read-only, that it cannot,
  // dimmed for as long as the drag is over the window.
  const dropInto = dropStore.use((s) => s.key === 'address:')
  const dropInvalid = chromeDropStore.use((s) => readOnly && s.kind !== null)
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
  const blocked = blockedPopupsOf(state, tab?.id)
  // Translation: the glyph stays once the page has been offered or translated (in the accent
  // while the translation shows), and comes up on hover for every other web page.
  const translation = tab && isWebPage ? translateStateOf(state, tab.id) : null
  const translateBarUp = tab ? barStateOf(state, tab.id) !== null : false
  return (
    <div
      ref={row}
      className={cn('zen-no-drag flex items-center gap-0.5', compact && 'flex-col', className)}
      // The bar the extension popovers and the downloads bubble hang from (v2 §9.20): flush
      // under it, aligned by half. (Its token family is the window's, from the `data-surface`
      // on SidebarTop's root.)
      data-bar={compact ? undefined : ''}
      data-zen-nav-row
      // The toolbar pane of the F6 rotation (lib/panes.ts): F6 lands on the address, Shift+Alt+T
      // on the first enabled control.
      data-pane="toolbar"
    >
      <NavigationButton
        tab={tab}
        title={hint('Back', state, 'nav.back')}
        enabled={Boolean(tab?.canGoBack)}
        command="tab.back"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </NavigationButton>
      <NavigationButton
        tab={tab}
        title={hint('Forward', state, 'nav.forward')}
        enabled={Boolean(tab?.canGoForward)}
        command="tab.forward"
      >
        <ArrowRight className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
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
        {tab?.loading ? (
          <X className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
        ) : (
          <RotateCw className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
        )}
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
          className={cn(
            'zen-squircle zen-pill group/pill mx-0.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-[var(--zen-element-bg)] px-2.5 text-left',
            !readOnly && 'hover:bg-[var(--zen-element-bg-hover)]'
          )}
          title={tab ? presentedUrl(tab.url) : 'Search or enter address'}
          data-zen-menu="urlpill"
          data-zen-menu-tab={tab?.id}
          data-readonly={readOnly || undefined}
          data-address-pill
          data-drop-into={dropInto || undefined}
          data-drop-invalid={dropInvalid || undefined}
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
            only `:focus-within` on their common ancestor holds through that instant. They stay
            as well while a chip has its popover up (`aria-expanded`), so the chips do not shift
            under a popover that was placed on one of them (§9.20).
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
                  indicator.state === 'certificate-error' && 'text-[var(--zen-danger)] opacity-100',
                  extension && 'opacity-100'
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
                {extension ? (
                  <ExtensionIcon icon={extension.icon} size={16} box={16} />
                ) : (
                  <IndicatorGlyph state={indicator.state} scheme={tab.url.split(':')[0] ?? ''} />
                )}
              </PillChip>
            ) : (
              <Search className="order-first h-3 w-3 shrink-0 opacity-60" />
            )}
            {tab && isWebPage && state.capabilities.requestBlocking && (
              <BlockedChip tab={tab} state={state} variant="desktop" />
            )}
            {tab && !extension && (tab.readerable || isReader) && (
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
            {tab && isReader && (
              // Edge's Immersive Reader "Text preferences" on its toolbar: a chip beside Reader
              // View's while an article is open, whose popup is the preferences popover;
              // `aria-expanded` follows it and `data-reader-prefs-chip` is what it hangs from
              // and what its Escape hands the keyboard back to (§9.22). In a narrow pill it goes
              // with the other extras (`zen-pill-extra`, §9.29): it reports no state the page
              // does not show itself, and at the default sidebar width the pill has room for
              // the two chips that stay (site information, Reader View) and no more – a third
              // would spill under the media hub's button. The reader document carries no
              // toolbar of its own (§10.1: this popover is the one home of its controls), so
              // the app menu's "Text Preferences…" is the way in while the chip is folded (the
              // popover then hangs centred).
              <PillChip
                label="Text preferences"
                title="Text preferences"
                popup="dialog"
                expanded={readerPrefsOpen}
                data-reader-prefs-chip=""
                className={cn(
                  'zen-pill-extra flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
                  // The anchor keeps its pressed fill while its popover is up (§9.20).
                  readerPrefsOpen && 'bg-[var(--zen-element-bg-hover)] opacity-100'
                )}
                onActivate={(e) => {
                  // The chip that put the popover away keeps the keyboard, as the anchor does
                  // after Escape (§9.22); a pointer press while it is up never gets here (the
                  // chrome layer consumes it), so this is the keyboard's toggle.
                  if (readerPrefsOpen) closeReaderPreferences({ keepFocus: true })
                  else void openReaderPreferences(tab.id, e.currentTarget.getBoundingClientRect())
                }}
              >
                <ALargeSmall className="h-3.5 w-3.5" />
              </PillChip>
            )}
            {tab && blocked.length > 0 && (
              // A 28 px chip (§9.3) whose popup is the blocked pop-ups list; `aria-expanded`
              // follows the popover and `data-blocked-popups-chip` is what it hangs from and
              // what its Escape hands the keyboard back to. A control on the window surface
              // (§9.29): its fills and the count's pill draw in the window family, which the
              // pill's `data-surface="window"` resolves.
              <PillChip
                label={
                  blocked.length === 1 ? 'Pop-up blocked' : `${blocked.length} pop-ups blocked`
                }
                title={
                  blocked.length === 1 ? 'Pop-up blocked' : `${blocked.length} pop-ups blocked`
                }
                popup="dialog"
                expanded={blockedOpen}
                data-blocked-popups-chip=""
                className={cn(
                  'zen-animate-pop flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 hover:bg-[var(--v2-control-fill)]',
                  // The anchor keeps its pressed fill while its popover is up (§9.20).
                  blockedOpen && 'bg-[var(--v2-control-fill-hover)]'
                )}
                onActivate={(e) => {
                  // The chip that put the popover away keeps the keyboard, as the anchor does
                  // after Escape (§9.22); a pointer press while it is up never gets here (the
                  // chrome layer consumes it), so this is the keyboard's toggle.
                  if (blockedOpen) closeBlockedPopups(false)
                  else void openBlockedPopups(tab.id, e.currentTarget.getBoundingClientRect())
                }}
              >
                <AppWindow className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
                {blocked.length > 1 && (
                  <span className="rounded-full bg-[var(--v2-control-fill)] px-2 text-[13px] leading-5 font-semibold text-[var(--v2-control-text-deemphasized)] tabular-nums">
                    {blocked.length}
                  </span>
                )}
              </PillChip>
            )}
            {tab && isWebPage && state.translate.available && (
              <PillChip
                label={translateBarUp ? 'Hide the translation bar' : 'Translate this page'}
                title={translateBarUp ? 'Hide the translation bar' : 'Translate this page'}
                className={cn(
                  'h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]',
                  translation &&
                    isTranslating(translation) &&
                    'text-[var(--zen-accent)] opacity-100',
                  translation
                    ? 'flex'
                    : 'hidden group-hover/pill:flex group-focus-within/chips:flex'
                )}
                onActivate={() => {
                  if (translateBarUp) run('translate.dismiss', { tabId: tab.id })
                  else run('translate.offer', { tabId: tab.id })
                }}
              >
                <Languages className="h-3.5 w-3.5" />
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
                    : 'zen-pill-extra hidden group-hover/pill:flex group-focus-within/chips:flex group-has-[[aria-expanded=true]]/chips:flex'
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
                className="zen-pill-extra hidden h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)] group-hover/pill:flex group-focus-within/chips:flex group-has-[[aria-expanded=true]]/chips:flex"
                onActivate={() => tab && run('tab.copyUrl', { tabId: tab.id })}
              >
                <Copy className="h-3 w-3" />
              </PillChip>
            )}
            {tab && <ZoomChip state={state} tab={tab} />}
            {tab && isWebPage && <AutofillChip state={state} tab={tab} />}
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
      <MediaHubButton state={state} />
      <DownloadButton state={state} activeTabId={tab?.id ?? null} />
      <ToolbarActions
        state={state}
        rowWidth={compact ? null : rowWidth}
        // The media and downloads buttons join the fixed set while they are in the row.
        fixedButtons={
          FIXED_BUTTONS +
          (mediaHubVisible(state) ? 1 : 0) +
          (downloadButtonVisible(state, downloadsUiState) ? 1 : 0)
        }
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
        <MoreHorizontal className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
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
