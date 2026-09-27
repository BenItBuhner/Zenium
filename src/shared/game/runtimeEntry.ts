/**
 * The entry of Roll's inline runtime (`virtual:zenium-game-runtime`, `scripts/inline-script.ts`):
 * bundled with `runtime.ts`, `logic.ts`, `page.ts` and `bridge.ts` into one script that the two
 * documents carrying the game – the no-connection page and `zen://game` – embed after their
 * markup (`inlineRuntime.ts`). It mounts every stage in the document, and nothing else: the page
 * script (`shared/pageScript.ts`) carries none of the game, only the best score's relay.
 */
import { mountGames } from './runtime'

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => mountGames(document), { once: true })
else mountGames(document)
