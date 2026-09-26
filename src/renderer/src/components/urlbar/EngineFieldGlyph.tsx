import type { JSX } from 'react'
import { useState } from 'react'
import { Search } from 'lucide-react'
import type { SearchEngine } from '@shared/types'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { searchEngineIconSrc } from '@renderer/lib/searchEngineIcons'
import { cn } from '@renderer/lib/utils'
import { TOOLBAR_STROKE } from '../v2/controls'

/**
 * Favicon addresses that have loaded in this session: a slot shows them from its first frame,
 * with no fallback painted first, so the double the morph paints (FakeboxMorphLayer) is the
 * field's twin at once.
 */
const loaded = new Set<string>()

/**
 * The mark at the start of a field for the engine it searches with (NTP-09; Chrome's search
 * engine logo, Edge's Bing mark): the engine's favicon at 20 – v2 §6's leading glyph on the
 * omnibox, the new tab page's resting field and the morph's double, whichever engine it is, the
 * vendor's default included – where `engineFieldFavicon` gives one; else the slot's own
 * fallback, the one it always showed: the omnibox field's 28 px letter tile (`tile`) or the new
 * tab field's magnifier (`magnifier`). An engine of the choice screen's that is not shipped
 * draws its bundled picture (`searchEngineIconSrc`). The favicon takes the slot once it has loaded
 * – the fallback is painted until then and stays if the image never comes, so the slot is never
 * blank (as a broken favicon leaves Chrome's globe) – arriving on a 120 ms opacity fade in place
 * (§11.4); an address that loaded once this session shows at once. The favicon keeps its own
 * colours: it is content drawn in chrome (§9.29). The desktop pill's empty tab takes it at 16
 * (`size`), the site-information slot's glyph size, with the magnifier at the row stroke.
 *
 * A mark, not a control (OMN-38, partial-by-design on the root's ruling of 2026-09-26): in
 * Chrome for Android 152 a tap on the default search engine's logo does nothing. Chromium tag
 * 152.0.7977.89, `chrome/browser/ui/android/omnibox/java/src/org/chromium/chrome/browser/omnibox/
 * status/StatusMediator.java`, `maybeUpdateStatusIconForSearchEngineIcon()`: the model takes the
 * engine's icon as `STATUS_ICON_RESOURCE` and `null` as its `STATUS_CLICK_LISTENER`. Chrome's
 * engine for one query is site search – the keyword, the engine's row – which the bar has
 * (`@keyword`, tab-to-search, Ctrl+K). So the phone field's slot stays a `role="img"` named for
 * the engine, inside no button and with no handler (`urlbarEngineGlyphInert.test.tsx` pins it);
 * a tap on it – a picker of the engines was built as #567's Form A and is kept on
 * `cursor/android-omnibox-engine-glyph-form-a-9271` – takes a ruling first.
 */
export function EngineFieldGlyph({
  engine,
  fallback,
  size = 20,
  className
}: {
  engine: SearchEngine
  fallback: 'tile' | 'magnifier'
  /** The favicon's box: §6's 20 on a field, 16 in the desktop pill (the slot's glyph size). */
  size?: 16 | 20
  /** Extra classes on the slot (the new tab field's placeholder ink for its magnifier). */
  className?: string
}): JSX.Element {
  // The core's cached copy where it holds one (HB-47); the engine's mark is no page's row, so
  // the live address stands where the cache has nothing, as it always did.
  const favicon = useFaviconSrc(searchEngineIconSrc(engine))
  const [arrived, setArrived] = useState<string | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  const image = favicon !== null && broken !== favicon
  const shown = image && (loaded.has(favicon) || arrived === favicon)
  const box = size === 16 ? 'h-4 w-4' : 'h-5 w-5'
  const img = image ? (
    <img
      src={favicon}
      alt=""
      className={cn(
        'zen-engine-field-favicon shrink-0 rounded-[3px]',
        box,
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
        className={cn('relative flex shrink-0 items-center justify-center', box, className)}
        data-testid="engine-field-glyph"
      >
        {!shown && (
          <Search
            className={cn('shrink-0', box)}
            strokeWidth={size === 16 ? TOOLBAR_STROKE : 1.75}
          />
        )}
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
