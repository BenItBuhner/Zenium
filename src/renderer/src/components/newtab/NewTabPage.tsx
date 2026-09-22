import type { CSSProperties, JSX, ReactNode, UIEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Building2,
  Camera,
  ClipboardPen,
  Cookie,
  Globe,
  History,
  Mic,
  Radio,
  Settings,
  VenetianMask
} from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { defaultSearchEngineOf } from '@shared/search'
import { getHost } from '@shared/url'
import { MAX_NEW_TAB_SHORTCUTS, newTabSections } from '@shared/newTab'
import { qrScanAvailable } from '@shared/qrScan'
import { voiceSearchAvailable } from '@shared/voice'
import { run } from '@renderer/lib/api'
import {
  fakeboxMorphStore,
  fakeboxScrolled,
  registerFakebox,
  tapFakebox
} from '@renderer/lib/fakeboxMorph'
import { useViewport } from '@renderer/lib/formFactor'
import { PROTECTION_TEXT } from '@renderer/lib/protectionUi'
import { topSites, type TopSite } from '@renderer/lib/historyAdapter'
import {
  composeTiles,
  loadWallpaperImage,
  newTabGrowStore,
  openCustomize,
  tileLabel,
  wallpaperImageStore,
  type TopSiteTile
} from '@renderer/lib/newtab'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import { startQrScan } from '@renderer/lib/qrScan'
import { contentAreaStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { useLongPress } from '../phone/useLongPress'
import { EngineFieldGlyph } from '../urlbar/EngineFieldGlyph'

interface Props {
  state: UIState
  /** The blank tab the page stands in for. */
  tab: Tab
  /** Chrome that takes the frame over (the omnibox) is up: keep the page but do not paint it. */
  hidden: boolean
}

/**
 * The phone's new tab page, drawn in the content frame where the blank page would be. The one
 * route is keyed on the tab's container: a private tab's blank page is the private new tab page
 * (NTP-31), every other blank tab's the space's page with its field and tiles. The two are
 * components of their own, so a blank tab changing hands between the modes mounts the other page
 * rather than re-using one's hooks.
 */
export function NewTabPage({ state, tab, hidden }: Props): JSX.Element {
  if (isPrivateTab(tab)) return <PrivateNewTabPage state={state} tab={tab} hidden={hidden} />
  return <SpaceNewTabPage state={state} tab={tab} hidden={hidden} />
}

/**
 * The bare page is the window's own gradient: drawn at the window's size and offset by the
 * frame's position, so the frame reads as a window onto the space rather than a second copy.
 */
function useWindowBackdrop(): CSSProperties | undefined {
  const area = contentAreaStore.use((s) => s.area)
  const viewport = useViewport()
  return area
    ? {
        backgroundSize: `${viewport.width}px ${viewport.height}px`,
        backgroundPosition: `${-area.x}px ${-area.y}px`
      }
    : undefined
}

/**
 * The space's new tab page: the space gradient as the page (a new tab in Zen is the window
 * itself), a search field on the floating URL bar's surface, and the most visited sites as
 * Essentials-style tiles. What the page shows is the preset's (or the customise sheet's) choice,
 * and the wallpaper presets put the space's colours – or a picked image under a legibility scrim
 * – behind it all.
 */
function SpaceNewTabPage({ state, tab, hidden }: Props): JSX.Element {
  const settings = state.settings.newTab
  const sections = newTabSections(settings)
  const growPhase = newTabGrowStore.use((s) => s.phase)
  const image = wallpaperImageStore.use()
  const backdrop = useWindowBackdrop()

  useEffect(() => {
    if (sections.wallpaper) void loadWallpaperImage()
  }, [sections.wallpaper])

  const wallpaper: 'none' | 'space' | 'image' = !sections.wallpaper
    ? 'none'
    : settings.background === 'image' && image.dataUrl
      ? 'image'
      : 'space'

  const style: CSSProperties | undefined =
    wallpaper === 'none'
      ? backdrop
      : wallpaper === 'image' && image.dataUrl
        ? { backgroundImage: `url("${image.dataUrl}")` }
        : undefined

  return (
    // A window surface (design language v2 §9.29): the page is the space's gradient, and the
    // tiles, their captions and the gear draw in the window family; the field is a panel on it.
    <div
      className="zen-ntp absolute inset-0 flex flex-col"
      data-surface="window"
      data-wallpaper={wallpaper}
      data-hidden={hidden || undefined}
      data-grow={growPhase !== 'idle' ? growPhase : undefined}
      style={style}
    >
      {wallpaper === 'image' && <div className="zen-ntp-scrim absolute inset-0" aria-hidden />}
      {/* The column scrolls where its content overflows the frame (a short viewport, large type),
          and its scroll carries the field toward the bar's pill slot (lib/fakeboxMorph.ts); the
          whole of it fades under the arriving omnibox. */}
      <div
        className="zen-ntp-scroll zen-ntp-fades relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4"
        style={{ overscrollBehavior: 'contain' }}
        onScroll={onNewTabScroll}
      >
        <div className="min-h-6" style={{ flex: 3 }} />
        {sections.searchBox && <SearchField state={state} tab={tab} />}
        {sections.shortcuts && <TopSites state={state} tab={tab} />}
        <div className="min-h-6" style={{ flex: 5 }} />
      </div>
      <button
        type="button"
        className="zen-ntp-fades zen-toolbar-button absolute h-11 w-11"
        style={{ right: 12, bottom: 12 }}
        aria-label="Customise the new tab page"
        onClick={openCustomize}
      >
        <Settings className="h-5 w-5" strokeWidth={1.75} />
      </button>
    </div>
  )
}

const PRIVATE_TITLE = "You're browsing privately"
const PRIVATE_DESCRIPTION =
  'Pages you open in private tabs leave nothing behind once the last one closes, and other ' +
  "people using this device won't see them. Downloads you save and bookmarks you add are kept."

/** What the private page tells (NTP-31): a heading and its rows, each a glyph and one line. */
const PRIVATE_EXPLAINER: Array<{ heading: string; rows: Array<[ReactNode, string]> }> = [
  {
    heading: "Zenium won't save",
    rows: [
      [<History key="history" />, 'Browsing history'],
      [<Cookie key="cookies" />, 'Cookies and site data'],
      [<ClipboardPen key="forms" />, 'Information entered in forms']
    ]
  },
  {
    heading: 'Still visible to',
    rows: [
      [<Globe key="sites" />, 'Websites you visit'],
      [<Building2 key="work" />, 'Your employer or school'],
      [<Radio key="isp" />, 'Your internet service provider']
    ]
  }
]

/**
 * The private new tab page (NTP-31; Chrome's Incognito and Edge's InPrivate page): the window's
 * gradient – the private theme's, which the window surfaces have blended to (§9.29) – with the
 * search field on it and an explainer of what Zenium keeps from the session and what it does
 * not, in the window family. The explainer is the first run's page vocabulary (§9.26, §9.27,
 * §9.2): the title block 22/600 with the mask glyph on its start and a description 15 at 69%,
 * then groups of one-line rows under 15/600 headings, all at the 16 gutter, and last Chrome's
 * Block third-party cookies switch over the core's setting (`ThirdPartyCookiesRow`). No tiles –
 * the most visited sites are the regular history's – and no customise gear: the page has one
 * look.
 */
function PrivateNewTabPage({ state, tab, hidden }: Props): JSX.Element {
  const growPhase = newTabGrowStore.use((s) => s.phase)
  const backdrop = useWindowBackdrop()
  return (
    <div
      className="zen-ntp zen-ntp-private absolute inset-0 flex flex-col"
      data-surface="window"
      data-wallpaper="none"
      data-private
      data-hidden={hidden || undefined}
      data-grow={growPhase !== 'idle' ? growPhase : undefined}
      data-testid="private-ntp"
      style={backdrop}
    >
      <div
        className="zen-ntp-scroll zen-ntp-fades relative flex min-h-0 flex-1 flex-col overflow-y-auto"
        style={{ overscrollBehavior: 'contain' }}
        onScroll={onNewTabScroll}
      >
        <div className="mx-auto flex w-full max-w-[520px] flex-col px-4 pb-6 pt-8">
          <SearchField state={state} tab={tab} />
          <div className="zen-firstrun-intro mt-8 flex flex-col gap-1">
            <h1 className="zen-firstrun-title flex items-center gap-2">
              <VenetianMask
                className="h-5 w-5 shrink-0"
                strokeWidth={1.75}
                aria-hidden
                data-testid="private-ntp-glyph"
              />
              <span>{PRIVATE_TITLE}</span>
            </h1>
            <p className="zen-firstrun-body zen-firstrun-deemphasized">{PRIVATE_DESCRIPTION}</p>
          </div>
          {PRIVATE_EXPLAINER.map(({ heading, rows }) => (
            <section key={heading} className="zen-firstrun-group -mx-4 flex flex-col">
              <h2 className="zen-firstrun-heading px-4 pb-1">{heading}</h2>
              <ul className="flex flex-col">
                {rows.map(([glyph, label]) => (
                  <li key={label} className="zen-firstrun-row">
                    <span className="zen-firstrun-row-glyph" aria-hidden>
                      {glyph}
                    </span>
                    <span className="min-w-0 flex-1">{label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <ThirdPartyCookiesRow state={state} />
        </div>
      </div>
    </div>
  )
}

const COOKIES_SWITCH_LABEL = 'Block third-party cookies'
// One line each at 13 px in the row's text column (about 300 px on a 412 px phone), a full stop
// like the page's other description lines; the locked line names the section as the root named
// it, Privacy, the short form of the Settings nav's "Privacy and Security".
const COOKIES_SWITCH_DESCRIPTION = 'Blocks third-party cookies in private tabs.'
const COOKIES_SWITCH_LOCKED = 'Blocked in every tab by Settings → Privacy.'

/**
 * Chrome's Incognito page's "Block third-party cookies" switch (NTP-31), private-only as
 * Chrome's is: it reads the core's `privacy.privateThirdPartyCookies` (#218's status of the
 * private contexts' setting, `Settings.privacy.thirdPartyCookiesPrivate`) – `blocked` is its
 * position – and writes through `privacy.setThirdPartyCookiesPrivate`: `block` when turned on,
 * `allow` when turned off, never `default`, so the choice survives a later change of the global
 * mode. Regular tabs keep the global mode whatever this switch says. While the global mode blocks
 * third-party cookies everywhere the status is `locked`: the switch shows on and disabled (§9.30:
 * the whole row laid out at .4, full size, inert), the description giving the reason, and the row
 * never writes in that state (the engine would keep a write for when the lock lifts, but the
 * chrome does not offer one). A §10.4 switch row on the shared row primitive with its window
 * modifier (`.zen-ntp-row`): the whole row is the switch, the glyph on the first line as the
 * explainer rows' are, the description 13 at 69 % under the label (a row's own description,
 * §9.1's stack), the switch centred on the row. The heading is the Settings cookies group's, so
 * the two surfaces name the setting alike.
 */
function ThirdPartyCookiesRow({ state }: { state: UIState }): JSX.Element {
  const { blocked, locked } = state.privacy.privateThirdPartyCookies
  return (
    <section className="zen-firstrun-group -mx-4 flex flex-col">
      <h2 className="zen-firstrun-heading px-4 pb-1">{PROTECTION_TEXT.cookies.heading}</h2>
      <button
        type="button"
        role="switch"
        aria-checked={blocked}
        aria-disabled={locked || undefined}
        className="zen-v2-row zen-ntp-row"
        data-testid="private-ntp-cookies"
        onClick={() => {
          if (locked) return
          run('privacy.setThirdPartyCookiesPrivate', { mode: blocked ? 'allow' : 'block' })
        }}
      >
        <span className="zen-firstrun-row-glyph self-start" aria-hidden>
          <Cookie />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="zen-firstrun-body">{COOKIES_SWITCH_LABEL}</span>
          <span className="zen-firstrun-small zen-firstrun-deemphasized line-clamp-2">
            {locked ? COOKIES_SWITCH_LOCKED : COOKIES_SWITCH_DESCRIPTION}
          </span>
        </span>
        <span className="zen-v2-switch" aria-hidden />
      </button>
    </section>
  )
}

/** The page's scroll carries the field toward the bar's pill slot (NTP-02, the scroll scrub). */
function onNewTabScroll(e: UIEvent<HTMLDivElement>): void {
  fakeboxScrolled(e.currentTarget.scrollTop)
}

/**
 * The search field: the floating URL bar's field with a placeholder, the search glyph and the
 * trailing icon buttons – the mic where the host has a speech recogniser (OMN-19: the listening
 * sheet, its result loading in this tab), the camera where it has a back camera (OMN-22, NTP-04:
 * the scan sheet, its payload loading in this tab). A tap on the field opens the omnibox for
 * this tab – the field itself never takes input, so what is typed goes where every other
 * address does. The field does not cut to the omnibox: it morphs into it (NTP-02 / MOT-08,
 * lib/fakeboxMorph.ts), which registers the field here and paints its double while it is on
 * its way (`data-away`: the page's own field yields to the double).
 */
function SearchField({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const fieldRef = useRef<HTMLDivElement>(null)
  const away = fakeboxMorphStore.use((s) => s.tabId === tab.id && !s.pageField)
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    return registerFakebox(tab.id, field, field.closest<HTMLElement>('.zen-ntp-scroll'))
  }, [tab.id])
  const voice = voiceSearchAvailable(state.capabilities)
  const camera = qrScanAvailable(state.capabilities)
  const trailing = voice || camera
  // The engine a search from here goes to, for the field's mark (NTP-09): the same resolution
  // as the omnibox's, so the page's field and the field it morphs into agree.
  const engine = defaultSearchEngineOf(
    state.searchEngines,
    state.settings.searchEngineId,
    state.searchEngineControl
  )
  return (
    // The floating URL bar's field is an opaque panel on the window: a page surface of its own.
    <div
      ref={fieldRef}
      role="group"
      aria-label="Search"
      className="zen-ntp-field flex w-full max-w-[520px]"
      data-surface="page"
      data-away={away || undefined}
    >
      <button
        type="button"
        className={cn(
          'zen-ntp-field-main flex h-full min-w-0 flex-1 items-center gap-3 pl-4 text-left',
          !trailing && 'pr-4'
        )}
        onClick={tapFakebox}
      >
        {/* The magnifier, or the engine's favicon when the engine is not the vendor's default
            (NTP-09): the double the morph paints carries the same mark (FakeboxMorphLayer). */}
        <EngineFieldGlyph engine={engine} fallback="magnifier" className="zen-ntp-placeholder" />
        {/* The pill's words (PhoneShell), one string for the address wherever it is asked for. */}
        <span className="zen-ntp-placeholder min-w-0 flex-1 truncate">Search or enter address</span>
      </button>
      {trailing && (
        <span className="flex shrink-0 items-center gap-0.5 pr-1.5">
          {voice && (
            <button
              type="button"
              className="zen-toolbar-button h-11 w-11"
              aria-label="Search by voice"
              onClick={() => void startVoiceSearch({ tabId: tab.id, newTab: false })}
            >
              <Mic className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
          {camera && (
            <button
              type="button"
              className="zen-toolbar-button h-11 w-11"
              aria-label="Scan a QR code"
              onClick={() => void startQrScan({ tabId: tab.id, newTab: false })}
            >
              <Camera className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * Two rows of four tiles: the pinned sites first, then the most visited ones by frecency, without
 * the hosts the user removed. The list is fetched when the page comes up and again when a pin or
 * a removal changes it; until then the page shows the field alone, and nothing at all when the
 * history is empty.
 */
function TopSites({ state, tab }: { state: UIState; tab: Tab }): JSX.Element | null {
  const { mode } = state.settings.newTab
  const { newTabShortcuts: pinned, newTabHiddenHosts: hiddenHosts } = state
  const [ranked, setRanked] = useState<TopSite[] | null>(null)
  const hiddenKey = hiddenHosts.join('\n')

  useEffect(() => {
    let cancelled = false
    void topSites(MAX_NEW_TAB_SHORTCUTS, hiddenHosts).then((sites) => {
      if (!cancelled) setRanked(sites)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the hosts are compared by content
  }, [hiddenKey])

  // Open tabs know icons the history may not have yet (a pinned site never visited since).
  const favicons = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of Object.values(state.tabs)) {
      if (!t.favicon) continue
      const host = getHost(t.url)
        .toLowerCase()
        .replace(/^www\./, '')
      if (host && !map.has(host)) map.set(host, t.favicon)
    }
    return map
  }, [state.tabs])

  const tiles = useMemo(
    () =>
      ranked
        ? composeTiles({ pinned, ranked, style: mode, n: MAX_NEW_TAB_SHORTCUTS, favicons })
        : [],
    [ranked, pinned, mode, favicons]
  )

  // Nothing until the history has answered; once it has and there is nothing to show, the empty
  // state (v2 section 9.17): one sentence, top-anchored where the tiles would be, no next step.
  if (ranked === null) return null
  if (tiles.length === 0) {
    return (
      <p className="zen-ntp-empty mt-12 w-full px-8 text-center" role="status">
        {mode === 'my-shortcuts'
          ? 'Shortcuts you pin will appear here'
          : 'Sites you visit often will appear here'}
      </p>
    )
  }
  return (
    <ul className="mt-6 grid w-full max-w-[420px] grid-cols-4 gap-3" aria-label="Most visited">
      {tiles.map((site, index) => (
        <li
          key={site.url}
          className="zen-ntp-site flex min-w-0 justify-center"
          style={{ '--zen-ntp-i': index } as CSSProperties}
        >
          <TopSiteTile site={site} tabId={tab.id} />
        </li>
      ))}
    </ul>
  )
}

/**
 * A 56 tile at radius 8 with the site's icon and, 8 below, its name (§9.29's phone sizes; the
 * look is the shared `zen-ntp-*` rules'); a hold opens the tile's menu.
 */
function TopSiteTile({ site, tabId }: { site: TopSiteTile; tabId: string }): JSX.Element {
  const label = tileLabel(site.title, site.url)
  const hold = useLongPress(() =>
    run('newtab.tileContextMenu', { url: site.url, title: site.title })
  )
  return (
    <button
      type="button"
      className="zen-v2-shortcut flex w-full min-w-0 flex-col items-center gap-2"
      aria-label={label}
      {...hold.handlers}
      onClick={() => {
        if (hold.swallowsClick()) return
        run('tab.navigate', { tabId, input: site.url })
      }}
    >
      <span className="zen-ntp-tile flex h-14 w-14 items-center justify-center">
        <TileIcon favicon={site.favicon} label={label} />
      </span>
      <span className="zen-ntp-caption w-full truncate text-center">{label}</span>
    </button>
  )
}

/**
 * The site's icon at 24, fading in once it has loaded; a letter in the deemphasised ink when the
 * site has none (or it failed), and the globe when there is no letter to show either (the
 * fallbacks' type and ink are the shared `zen-ntp-*` rules', the desktop page's too).
 */
function TileIcon({ favicon, label }: { favicon: string | null; label: string }): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState<string | null>(null)
  const src = favicon && broken !== favicon ? favicon : null
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={24}
        height={24}
        draggable={false}
        className={cn('zen-ntp-icon h-6 w-6 object-contain', loaded && 'zen-ntp-icon-loaded')}
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(favicon)}
      />
    )
  }
  const letter = label.trim().charAt(0).toUpperCase()
  if (!letter) return <Globe className="h-6 w-6" strokeWidth={1.5} />
  return (
    <span className="zen-ntp-letter flex h-6 w-6 items-center justify-center" aria-hidden>
      {letter}
    </span>
  )
}
