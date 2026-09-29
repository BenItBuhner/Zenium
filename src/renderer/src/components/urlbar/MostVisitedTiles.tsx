import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import type { Suggestion } from '@shared/types'
import { MOST_VISITED_GROUP } from '@shared/zeroSuggest'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { tileLabel } from '@renderer/lib/newtab'
import { cn } from '@renderer/lib/utils'

/**
 * The most visited sites over the zero-suggest list on the touch layouts (OMN-04; Chrome for
 * Android's `MostVisitedTilesCarousel` over a web page): the core's `Most visited` rows
 * ({@link MOST_VISITED_GROUP}) as one horizontally scrolling row of tiles – the new tab page's
 * own tile at a smaller size (§9.29's shared `zen-ntp-*` look: a 48 square at the card radius on
 * the window's fill, the site's icon at 20 or its letter, the site's name at 13 on one line
 * under it), dissolving at the edge that has more past it. A tile opens its site as a row's
 * pick would; the field keeps the focus through the press, as it does through a row's.
 *
 * One list item of the suggestions list, presentational: the tiles are buttons in a named group,
 * and the options a screen reader counts are the rows alone.
 */
export function MostVisitedTiles({
  tiles,
  sheet,
  onPick
}: {
  tiles: readonly Suggestion[]
  /** The phone sheet's list (the card's inset) rather than the tablet popup's (the rows' gutter). */
  sheet: boolean
  onPick: (item: Suggestion, e: React.MouseEvent) => void
}): JSX.Element {
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'x' })
  return (
    <li role="presentation" className="shrink-0" data-testid="urlbar-most-visited" data-tiles="">
      <div
        ref={fade}
        role="group"
        aria-label={MOST_VISITED_GROUP}
        className={cn('zen-omnibox-tiles flex', sheet && 'zen-omnibox-tiles-sheet')}
        style={{ touchAction: 'pan-x', overscrollBehaviorX: 'contain' }}
      >
        {tiles.map((item) => (
          <MostVisitedTile key={item.id} item={item} onPick={(e) => onPick(item, e)} />
        ))}
      </div>
    </li>
  )
}

function MostVisitedTile({
  item,
  onPick
}: {
  item: Suggestion
  onPick: (e: React.MouseEvent) => void
}): JSX.Element {
  const url = item.url ?? ''
  const label = tileLabel(item.title, url)
  const touch = useRef(false)
  return (
    <button
      type="button"
      className="zen-v2-shortcut zen-omnibox-tile flex shrink-0 flex-col items-center gap-1.5"
      aria-label={label}
      data-url={url}
      onPointerDown={(e) => {
        // As a row's press: the field keeps the focus (no blur, no keyboard flicker). A mouse
        // picks on the press; a finger picks on the tap, so the row can still be panned.
        e.preventDefault()
        if (e.pointerType === 'mouse') {
          if (e.button === 0) onPick(e)
        } else touch.current = true
      }}
      onClick={(e) => {
        if (!touch.current) return
        touch.current = false
        onPick(e)
      }}
    >
      <span className="zen-ntp-tile flex h-12 w-12 items-center justify-center">
        <TileIcon favicon={item.favicon} url={url} label={label} />
      </span>
      <span className="zen-ntp-caption w-full truncate text-center">{label}</span>
    </button>
  )
}

/**
 * The site's icon at 20; its letter in the deemphasised ink when it has none (or it failed), the
 * globe when there is no letter either – the new tab page's fallbacks (`TileIcon` there) at the
 * smaller size. The icon is the core's cached copy where it holds one (HB-47); an uncached one is
 * fetched live only while the site is open in a tab, as the page's tiles and the rows do.
 */
function TileIcon({
  favicon,
  url,
  label
}: {
  favicon: string | null
  url: string
  label: string
}): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const resolved = useFaviconSrc(favicon, url)
  const src = resolved && broken !== resolved ? resolved : null
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={20}
        height={20}
        draggable={false}
        className="zen-ntp-icon h-5 w-5 object-contain"
        onError={() => setBroken(src)}
      />
    )
  }
  const letter = label.trim().charAt(0).toUpperCase()
  if (!letter) return <Globe className="h-5 w-5" strokeWidth={1.5} />
  return (
    <span className="zen-ntp-letter flex h-5 w-5 items-center justify-center" aria-hidden>
      {letter}
    </span>
  )
}
