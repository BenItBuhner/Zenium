import type { CSSProperties, JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Camera, Globe, Mic, Search, Settings } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { getHost } from '@shared/url'
import { MAX_TOP_SITES, newTabSections } from '@shared/newtab'
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
 * space gradient as the page, a search field in the address pill's vocabulary, and the most
 * visited sites as tiles. Nothing is boxed; what the page shows is the preset's (or the
 * customise sheet's) choice, and the wallpaper presets put the space's colours – or a picked
 * image under a legibility scrim – behind it all.
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
    <div
      className="zen-ntp absolute inset-0 flex flex-col"
      data-wallpaper={wallpaper}
      data-hidden={hidden || undefined}
      data-grow={growPhase !== 'idle' ? growPhase : undefined}
      style={style}
    >
      {wallpaper === 'image' && <div className="zen-ntp-scrim absolute inset-0" aria-hidden />}
      <div className="relative flex min-h-0 flex-1 flex-col items-center px-6">
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
 * The search field: the address pill's shape with a placeholder, the search glyph and the two
 * trailing slots for voice and visual search. A tap opens the omnibox for this tab – the field
 * itself never takes input, so what is typed goes where every other address does.
 */
function SearchField({ tab }: { tab: Tab }): JSX.Element {
  const open = (): void => void openUrlbar('edit', tab.id, { attached: true })
  return (
    <div role="group" aria-label="Search" className="zen-ntp-field flex w-full max-w-[520px]">
      <button
        type="button"
        className="zen-ntp-field-main flex h-11 min-w-0 flex-1 items-center gap-3 pl-4 text-left"
        onClick={open}
      >
        <Search className="h-5 w-5 shrink-0 text-[var(--zen-muted)]" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--zen-faint)]">
          Search or type URL
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 pr-1.5">
        <button
          type="button"
          className="zen-ntp-slot flex h-8 w-8 items-center justify-center rounded-full text-[var(--zen-muted)]"
          aria-label="Search by voice"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('zen-voice-search', { detail: { tabId: tab.id } }))
          }
        >
          <Mic className="h-5 w-5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="zen-ntp-slot flex h-8 w-8 items-center justify-center rounded-full text-[var(--zen-muted)]"
          aria-label="Search with your camera"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('zen-visual-search', { detail: { tabId: tab.id } })
            )
          }
        >
          <Camera className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </span>
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

  if (tiles.length === 0) return null
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

/** A 56 squircle with the site's icon and its name beneath; a hold opens the tile's menu. */
function TopSiteTile({ site, tabId }: { site: TopSiteTile; tabId: string }): JSX.Element {
  const label = tileLabel(site.title, site.url)
  const hold = useLongPress(() =>
    run('newtab.tileContextMenu', { url: site.url, title: site.title })
  )
  return (
    <button
      type="button"
      className="zen-ntp-site-button flex w-full min-w-0 flex-col items-center gap-1.5"
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
      <span className="w-full truncate text-center text-[12px] leading-4 text-[var(--zen-muted)]">
        {label}
      </span>
    </button>
  )
}

/**
 * The site's icon at 24, fading in once it has loaded; a letter in the element tone when the site
 * has none (or it failed), and the globe when there is no letter to show either.
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
