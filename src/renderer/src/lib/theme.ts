import { run } from './api'

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
 * The door to the theme picker for the active space, from a place that is not the space's own
 * menu (the Settings theme row at the default look; Chrome's row opens Customize Chrome): the
 * `theme.open` action, as the command palette runs it.
 */
export function openThemePicker(): void {
  run('urlbar.runCommand', { action: 'theme.open' })
}
