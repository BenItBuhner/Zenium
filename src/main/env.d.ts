/** Build-time constants (`define` in electron.vite.config.ts). */
declare const __ZENIUM_APPLE_TEAM_ID__: string

/**
 * Vite's `?raw` import of a Markdown file as text: the `zenium-browser` Agent Skill
 * (`resources/skills/zenium-browser/SKILL.md`) is bundled into the main process this way, so the
 * installer writes the same text in development and in the packaged app.
 */
declare module '*.md?raw' {
  const text: string
  export default text
}

/**
 * The held-key notice's script for a DevTools toolbox (`platform/devtoolsQuitHoldPanel.ts`),
 * bundled at build time into one IIFE (`scripts/inline-script.ts`) for the main process to run
 * in the frontend's document (`platform/devtoolsKeys.ts`).
 */
declare module 'virtual:zenium-devtools-quit-hold-panel' {
  const source: string
  export default source
}
