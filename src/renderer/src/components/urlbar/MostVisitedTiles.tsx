import type { JSX } from 'react'
import { useRef } from 'react'
import type { Suggestion } from '@shared/types'
import { MOST_VISITED_GROUP } from '@shared/zeroSuggest'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { tileLabel } from '@renderer/lib/newtab'
import { cn } from '@renderer/lib/utils'
import { TileIcon } from '../newtab/TileIcon'

/**
 * The new tab page's tiles over the zero-suggest list on the touch layouts (OMN-04; Chrome for
 * Android's `MostVisitedTilesCarousel` over a web page): the core's `Most visited` rows
 * ({@link MOST_VISITED_GROUP}) – the page's own list – as one horizontally scrolling row of the
 * host's new tab page tile at its own size (§9.29's shared `zen-ntp-*` look: on the phone the
 * chrome-drawn page's 56 square with the 24 icon, on the tablet the served document's 64 with
 * the 32, each at the card radius on the window's fill, the site's letter where it has no icon,
 * the site's name at 13 on one line 8 under it), in 64-wide columns 8 apart, dissolving at the
 * edge that has more past it. A tile opens its site as a row's pick would; the field keeps the
 * focus through the press, as it does through a row's.
 *
 * One list item of the suggestions list, presentational: the tiles are buttons in a named group,
 * and the options a screen reader counts are the rows alone.
 */
export function MostVisitedTiles({
  tiles,
  sheet,
  phone,
  onPick
}: {
  tiles: readonly Suggestion[]
  /** The phone sheet's list (the card's inset) rather than the tablet popup's (the rows' gutter). */
  sheet: boolean
  /** The phone layout: its page's tile (56, the 24 icon); otherwise the tablet's (64, the 32). */
  phone: boolean
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
          <MostVisitedTile
            key={item.id}
            item={item}
            phone={phone}
            onPick={(e) => onPick(item, e)}
          />
        ))}
      </div>
    </li>
  )
}

function MostVisitedTile({
  item,
  phone,
  onPick
}: {
  item: Suggestion
  phone: boolean
  onPick: (e: React.MouseEvent) => void
}): JSX.Element {
  const url = item.url ?? ''
  const label = tileLabel(item.title, url)
  const touch = useRef(false)
  return (
    <button
      type="button"
      className="zen-v2-shortcut zen-omnibox-tile flex shrink-0 flex-col items-center gap-2"
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
      <span
        className={cn(
          'zen-ntp-tile flex items-center justify-center',
          phone ? 'h-14 w-14' : 'h-16 w-16'
        )}
      >
        <TileIcon favicon={item.favicon} url={url} label={label} size={phone ? 24 : 32} />
      </span>
      <span className="zen-ntp-caption w-full truncate text-center">{label}</span>
    </button>
  )
}
