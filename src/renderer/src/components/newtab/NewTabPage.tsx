import type { CSSProperties, JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Camera, Globe, Mic, Search, Settings } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { getHost } from '@shared/url'
import {
  MAX_TOP_SITES,
  VISUAL_SEARCH_AVAILABLE,
  VOICE_SEARCH_AVAILABLE,
  newTabSections
} from '@shared/newtab'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
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
import { contentAreaStore, openUrlbar } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useLongPress } from '../phone/useLongPress'

interface Props {
  state: UIState
  /** The blank tab the page stands in for. */
  tab: Tab
  /** Chrome that takes the frame over (the omnibox) is up: keep the page but do not paint it. */
  hidden: boolean
}

/**
 * The phone's new tab page, drawn in the content frame where the blank page would be: the
 * space gradient as the page (a new tab in Zen is the window itself), a search field on the
 * floating URL bar's surface, and the most visited sites as Essentials-style tiles. What the
 * page shows is the preset's (or the customise sheet's) choice, and the wallpaper presets put
 * the space's colours – or a picked image under a legibility scrim – behind it all.
 */
export function NewTabPage({ state, tab, hidden }: Props): JSX.Element {
  const settings = state.settings.newTab
  const sections = newTabSections(settings)
  const growPhase = newTabGrowStore.use((s) => s.phase)
  const image = wallpaperImageStore.use()
  const area = contentAreaStore.use((s) => s.area)
  const viewport = useViewport()

  useEffect(() => {
    if (sections.wallpaper) void loadWallpaperImage()
  }, [sections.wallpaper])

  const wallpaper: 'none' | 'space' | 'image' = !sections.wallpaper
    ? 'none'
    : settings.wallpaper === 'image' && image.dataUrl
      ? 'image'
      : 'space'

  // The bare page is the window's own gradient: drawn at the window's size and offset by the
  // frame's position, so the frame reads as a window onto the space rather than a second copy.
  const style: CSSProperties | undefined =
    wallpaper === 'none' && area
      ? {
          backgroundSize: `${viewport.width}px ${viewport.height}px`,
          backgroundPosition: `${-area.x}px ${-area.y}px`
        }
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
      <div className="relative flex min-h-0 flex-1 flex-col items-center px-4">
        <div className="min-h-6" style={{ flex: 3 }} />
        {sections.searchBox && <SearchField tab={tab} />}
        {sections.shortcuts && <TopSites state={state} tab={tab} />}
        <div className="min-h-6" style={{ flex: 5 }} />
      </div>
      <button
        type="button"
        className="zen-toolbar-button absolute h-11 w-11"
        style={{ right: 12, bottom: 12 }}
        aria-label="Customise the new tab page"
        onClick={openCustomize}
      >
        <Settings className="h-5 w-5" strokeWidth={1.75} />
      </button>
    </div>
  )
}

/**
 * The search field: the floating URL bar's field with a placeholder, the search glyph and, once
 * their handlers exist, the trailing icon buttons for voice and visual search. A tap opens the
 * omnibox for this tab – the field itself never takes input, so what is typed goes where every
 * other address does.
 */
function SearchField({ tab }: { tab: Tab }): JSX.Element {
  const open = (): void => void openUrlbar('edit', tab.id, { attached: true })
  const trailing = VOICE_SEARCH_AVAILABLE || VISUAL_SEARCH_AVAILABLE
  const dispatch = (name: 'zen-voice-search' | 'zen-visual-search'): void => {
    window.dispatchEvent(new CustomEvent(name, { detail: { tabId: tab.id } }))
  }
  return (
    // The floating URL bar's field is an opaque panel on the window: a page surface of its own.
    <div
      role="group"
      aria-label="Search"
      className="zen-ntp-field flex w-full max-w-[520px]"
      data-surface="page"
    >
      <button
        type="button"
        className={cn(
          'zen-ntp-field-main flex h-full min-w-0 flex-1 items-center gap-3 pl-4 text-left',
          !trailing && 'pr-4'
        )}
        onClick={open}
      >
        <Search className="zen-ntp-placeholder h-5 w-5 shrink-0" strokeWidth={1.75} />
        <span className="zen-ntp-placeholder min-w-0 flex-1 truncate text-[15px] leading-5">
          Search or type URL
        </span>
      </button>
      {trailing && (
        <span className="flex shrink-0 items-center gap-0.5 pr-1.5">
          {VOICE_SEARCH_AVAILABLE && (
            <button
              type="button"
              className="zen-toolbar-button h-11 w-11"
              aria-label="Search by voice"
              onClick={() => dispatch('zen-voice-search')}
            >
              <Mic className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
          {VISUAL_SEARCH_AVAILABLE && (
            <button
              type="button"
              className="zen-toolbar-button h-11 w-11"
              aria-label="Search with your camera"
              onClick={() => dispatch('zen-visual-search')}
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
  const { pinned, hiddenHosts, shortcutStyle } = state.settings.newTab
  const [ranked, setRanked] = useState<TopSite[] | null>(null)
  const hiddenKey = hiddenHosts.join('\n')

  useEffect(() => {
    let cancelled = false
    void topSites(MAX_TOP_SITES, hiddenHosts).then((sites) => {
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
        ? composeTiles({ pinned, ranked, style: shortcutStyle, n: MAX_TOP_SITES, favicons })
        : [],
    [ranked, pinned, shortcutStyle, favicons]
  )

  // Nothing until the history has answered; once it has and there is nothing to show, the empty
  // state (v2 section 9.17): one sentence, top-anchored where the tiles would be, no next step.
  if (ranked === null) return null
  if (tiles.length === 0) {
    return (
      <p className="zen-ntp-empty mt-12 w-full px-8 text-center" role="status">
        {shortcutStyle === 'my-shortcuts'
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

/** A 56 tile at radius 8 with the site's icon and its name beneath; a hold opens the tile's menu. */
function TopSiteTile({ site, tabId }: { site: TopSiteTile; tabId: string }): JSX.Element {
  const label = tileLabel(site.title, site.url)
  const hold = useLongPress(() =>
    run('newtab.tileContextMenu', { url: site.url, title: site.title })
  )
  return (
    <button
      type="button"
      className="zen-v2-shortcut flex w-full min-w-0 flex-col items-center gap-1.5"
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
 * site has none (or it failed), and the globe when there is no letter to show either.
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
  if (!letter) return <Globe className="h-6 w-6 opacity-60" strokeWidth={1.5} />
  return (
    <span
      className="zen-ntp-letter flex h-6 w-6 items-center justify-center text-[13px] font-semibold leading-none"
      aria-hidden
    >
      {letter}
    </span>
  )
}
