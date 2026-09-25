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
