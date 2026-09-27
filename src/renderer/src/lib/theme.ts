import { placedAnchor, type Anchor } from './anchor'
import { run } from './api'
import { browserStore } from './browserStore'
import { activeTab } from './selectors'
import { openOverlay } from './ui'

/**
 * The one reset of a space's theme (settings-30; Chrome's Appearance › Theme › "Reset to
 * default", `ThemeService::UseDefaultTheme`): the theme picker's "Reset to default" and the
 * Settings row's call this and nothing else (§9.1: one action, one vocabulary – one name). The
 * space's `theme` goes to null – the default look, `resolveTheme(null)` – through the same
 * `space.update` the picker's edits take; the picker, if open, follows the state it reads.
 */
export function resetSpaceTheme(spaceId: string): void {
  run('space.update', { spaceId, patch: { theme: null } })
}

/**
 * The door to the theme picker for a space from a place that is not the space's own menu: the
 * Settings theme row at the default look (Chrome's row opens Customize Chrome). It opens the
 * `theme` overlay for `spaceId` – the row edits the active space's theme – and, given the
 * control that was pressed (`anchor`: the row's Change… button, as the desktop's action button
 * passes itself), hangs the picker from it (§9.20, #572's L8): end-aligned under the button, in
 * the one anchor call `placeUnder` makes; the store keeps the anchor's boxes alone
 * (`placedAnchor`). Without one the picker opens at its seat, as the palette's and the space
 * menu's `theme.open` open it through the core.
 */
export function openThemePicker(spaceId: string, anchor?: Anchor): void {
  const state = browserStore.get().state
  void openOverlay('theme', state ? (activeTab(state)?.id ?? null) : null, spaceId, null, null, {
    anchor: anchor ? placedAnchor(anchor) : null
  })
}
