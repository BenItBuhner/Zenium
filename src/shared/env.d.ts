/**
 * Build-time configuration injected by Vite. `VITE_*` variables are visible to the Electron main
 * process, the renderer and the Android chrome bundle alike; the release workflow sets them.
 */
interface ImportMetaEnv {
  /**
   * Base64 raw ed25519 public key(s) (comma separated) the update manifest must be signed with.
   * Empty or unset: manifest signatures are not enforced (HTTPS + checksums only).
   */
  readonly VITE_ZEN_UPDATE_PUBLIC_KEY?: string
  /** `"true"` when the macOS app was code-signed by the release pipeline (Squirrel.Mac can swap it in place). */
  readonly VITE_ZEN_MAC_SIGNED?: string
}

/**
 * Vite's `?raw` import of a stylesheet as text, for the node build (main, preload, core): the
 * renderer gets it from `vite/client`. `newTabPage.ts` reads main.css's token blocks this way.
 */
declare module '*.css?raw' {
  const css: string
  export default css
}
