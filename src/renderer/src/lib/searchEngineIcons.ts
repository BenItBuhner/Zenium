import bing from '@renderer/assets/search-engines/bing.png?no-inline'
import brave from '@renderer/assets/search-engines/brave.png?no-inline'
import duckduckgo from '@renderer/assets/search-engines/duckduckgo.png?no-inline'
import ecosia from '@renderer/assets/search-engines/ecosia.png?no-inline'
import google from '@renderer/assets/search-engines/google.png?no-inline'
import privacywall from '@renderer/assets/search-engines/privacywall.png?no-inline'
import qwant from '@renderer/assets/search-engines/qwant.png?no-inline'
import seznam from '@renderer/assets/search-engines/seznam.png?no-inline'
import startpage from '@renderer/assets/search-engines/startpage.png?no-inline'
import yahoo from '@renderer/assets/search-engines/yahoo.png?no-inline'
import yep from '@renderer/assets/search-engines/yep.png?no-inline'
import type { SearchEngine } from '@shared/types'
import { DEFAULT_SEARCH_ENGINES, engineFieldFavicon } from '@shared/search'

/*
 * The search-engine choice screen's icons (W6-2), bundled with the chrome as Chrome bundles
 * its own: each engine's documented icon (Chromium's `favicon_url` for it, `shared/search.ts`)
 * read once and kept as a PNG at the icon's largest frame up to 64 px
 * (`assets/search-engines/<id>.png`, 0.7–2.9 KB each, 19 KB in all), so the screen asks no
 * engine's server for anything before the user has chosen – eight requests to eight parties
 * would tell each of them a device is at the choice screen – and draws the same picture
 * offline, from a data-centre address (where an engine may refuse the request) and in a still.
 * `?no-inline`: the pictures are files beside the bundle, never bytes in the script the phone
 * loads too. Yahoo's country editions share Yahoo's icon, as Chrome's do.
 */
const ICONS: Readonly<Record<string, string>> = {
  bing,
  brave,
  duckduckgo,
  ecosia,
  google,
  privacywall,
  qwant,
  seznam,
  startpage,
  yep
}

/** The bundled icon for the engine `engineId`, or null: the screen draws its letter then. */
export function bundledSearchEngineIcon(engineId: string): string | null {
  if (engineId.startsWith('yahoo_')) return yahoo
  return ICONS[engineId] ?? null
}

/**
 * The address the chrome draws an engine's mark from wherever it shows one (the field's leading
 * glyph, Settings › Search's rows): for an engine of the choice screen's that Zenium does not
 * ship, the picture bundled for its id – the profile carries only the engine's documented icon
 * address (`favicon`, the reference `choose` stores), and an engine may refuse another origin's
 * `<img>` that address (Qwant answers it with `Cross-Origin-Resource-Policy: same-origin`);
 * for every other engine its `favicon` as it always was – the shipped ones' live or cached
 * address (`engineFieldFavicon`), a discovered or hand-added engine's own.
 */
export function searchEngineIconSrc(engine: Pick<SearchEngine, 'id' | 'favicon'>): string | null {
  if (!DEFAULT_SEARCH_ENGINES.some((e) => e.id === engine.id)) {
    const bundled = bundledSearchEngineIcon(engine.id)
    if (bundled) return bundled
  }
  return engineFieldFavicon(engine)
}
