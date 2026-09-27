/**
 * Roll's runtime as the documents carry it (ERR-03, §9.17 "the runtime carried by the two
 * documents that mount it, costing every other page nothing"): the bundle of `runtimeEntry.ts`,
 * built at build time (`scripts/inline-script.ts`, `virtual:zenium-game-runtime`), written into
 * the no-connection page and `zen://game` by `zenPages.ts` as one inline script after the game's
 * fragment. The page script the hosts run in every document (`page.js` on the phone, read
 * eagerly at boot; the desktop preload) has no byte of it.
 *
 * The tag carries `GAME_RUNTIME_ATTRIBUTE` (`page.ts`), by which a test pins its presence on the
 * two documents and its absence on every other, and by which the preview host
 * (`android/preview.ts`) swaps in its posing stand-in for the stills.
 */
import source from 'virtual:zenium-game-runtime'
import { GAME_RUNTIME_ATTRIBUTE } from './page'

/** The inline script. `</script` inside the source (none today) would end the tag early: escaped. */
export function gameRuntimeScriptHtml(): string {
  return `<script ${GAME_RUNTIME_ATTRIBUTE}>${source.replace(/<\/script/gi, '<\\/script')}</script>`
}
