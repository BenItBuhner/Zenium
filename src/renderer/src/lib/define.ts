import type { DefineDefinition, DefineRefusal, DefineResult } from '@shared/types'
import { run } from './api'
import { uiStore, type DefineRequest } from './ui'

/** How many senses the surface shows across the entries (Edge's Define card shows a few, not the page). */
export const DEFINE_SENSES_MAX = 3

/** The first `DEFINE_SENSES_MAX` senses across the entries, each with its part of speech; empty text skipped. */
export function senses(
  result: DefineResult,
  max = DEFINE_SENSES_MAX
): Array<{ partOfSpeech: string; definitions: DefineDefinition[] }> {
  const out: Array<{ partOfSpeech: string; definitions: DefineDefinition[] }> = []
  let left = max
  for (const entry of result.entries) {
    if (left <= 0) break
    const definitions = entry.definitions.filter((d) => d.text.trim() !== '').slice(0, left)
    if (definitions.length === 0) continue
    out.push({ partOfSpeech: entry.partOfSpeech, definitions })
    left -= definitions.length
  }
  return out
}

/**
 * The Define surface (CT-39; Edge's mini menu's Define): the core asked (`define.show` event,
 * from the mini menu's chip or the phone's selection toolbar) and the definition popover
 * (desktop) or sheet (phone) goes up for the request (`DefineLayer`). A user-opened surface, it
 * takes the keyboard (v2 draft §9.22), so the chrome gets the focus the page had; the surface
 * itself holds the page's capture behind it while it is up (`useFloatingChrome`) and gives the
 * focus back when it goes.
 */
export function openDefine(request: DefineRequest): void {
  run('focus.chrome', undefined)
  // The one selection surface at a time: the newer request takes the translation popover's place.
  uiStore.set({ define: request, translateSelection: null, drawerOpen: false })
}

export function closeDefine(): void {
  if (!uiStore.get().define) return
  uiStore.set({ define: null })
}

/**
 * What the surface says when Wiktionary gave no definition (`DefineLookup`'s refusal): one
 * sentence of the thing, uncontracted, with its full stop; `not-found` names the term.
 */
export function defineRefusalMessage(reason: DefineRefusal, term: string): string {
  switch (reason) {
    case 'invalid-term':
      return 'Only a word or a short phrase can be defined.'
    case 'not-found':
      return `No definition found for “${term}”.`
    case 'offline':
      return 'Wiktionary could not be reached.'
    case 'unavailable':
      return 'Wiktionary did not answer.'
    case 'malformed':
      return 'Wiktionary’s answer could not be read.'
  }
}

const flags = globalThis as unknown as { __zenDefineWired?: boolean }
if (!flags.__zenDefineWired) {
  flags.__zenDefineWired = true
  // Another chrome surface (URL bar, panel, drawer, menu, another sheet) replaces the surface,
  // as it does the translation popover (`lib/translate.ts`); that popover replaces this surface
  // as it opens (`openTranslateSelection`).
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if (
      ui.define &&
      (ui.urlbar.open ||
        ui.overlay !== 'none' ||
        ui.drawerOpen ||
        ui.siteInfoOpen ||
        ui.stageActive)
    )
      closeDefine()
  })
}
