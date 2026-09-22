import type { JSX } from 'react'
import { useState } from 'react'
import { Search } from 'lucide-react'
import type { SearchEngine } from '@shared/types'
import { engineFieldFavicon } from '@shared/search'
import { cn } from '@renderer/lib/utils'

/**
 * Favicon addresses that have loaded in this session: a slot shows them from its first frame,
 * with no fallback painted first, so the double the morph paints (FakeboxMorphLayer) is the
 * field's twin at once.
 */
const loaded = new Set<string>()

/**
 * The mark at the start of a field for the engine it searches with (NTP-09; Chrome's search
 * engine logo, Edge's Bing mark): the engine's favicon at 20 – v2 §9.29's field glyph – where
 * `engineFieldFavicon` gives one, which is when the engine is not the vendor's default; else the
 * slot's own fallback, the one it always showed: the omnibox field's 28 px letter tile (`tile`)
 * or the new tab field's magnifier (`magnifier`). The favicon takes the slot once it has loaded
 * – the fallback is painted until then and stays if the image never comes, so the slot is never
 * blank (as a broken favicon leaves Chrome's globe) – arriving on a 120 ms opacity fade in place
 * (§11.4); an address that loaded once this session shows at once. The favicon keeps its own
 * colours: it is content drawn in chrome (§9.29).
 */
export function EngineFieldGlyph({
  engine,
  fallback,
  className
}: {
  engine: SearchEngine
  fallback: 'tile' | 'magnifier'
  /** Extra classes on the slot (the new tab field's placeholder ink for its magnifier). */
  className?: string
}): JSX.Element {
  const favicon = engineFieldFavicon(engine)
  const [arrived, setArrived] = useState<string | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  const image = favicon !== null && broken !== favicon
  const shown = image && (loaded.has(favicon) || arrived === favicon)
  const img = image ? (
    <img
      src={favicon}
      alt=""
      className={cn(
        'zen-engine-field-favicon h-5 w-5 shrink-0 rounded-[3px]',
        !shown && 'invisible absolute'
      )}
      data-arrived={arrived === favicon || undefined}
      data-testid="engine-field-favicon"
      referrerPolicy="no-referrer"
      onLoad={() => {
        loaded.add(favicon)
        setArrived(favicon)
      }}
      onError={() => setBroken(favicon)}
    />
  ) : null
  if (fallback === 'magnifier') {
    return (
      <span
        className={cn('relative flex h-5 w-5 shrink-0 items-center justify-center', className)}
        data-testid="engine-field-glyph"
      >
        {!shown && <Search className="h-5 w-5 shrink-0" strokeWidth={1.75} />}
        {img}
      </span>
    )
  }
  return (
    <span
      role="img"
      aria-label={`Search engine: ${engine.name}`}
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center',
        !shown && 'rounded-full bg-[var(--zen-element-bg)] text-[11px] font-semibold',
        className
      )}
      data-testid="engine-field-glyph"
    >
      {!shown && engine.glyph}
      {img}
    </span>
  )
}
