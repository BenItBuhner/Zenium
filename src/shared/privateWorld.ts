/**
 * The world Zenium's own one-shot page scripts run in on the desktop – the image search's
 * thumbnail script (`imageUpload.ts` `imageFetchScript`) – and the wire that reaches it in a
 * sub-frame.
 *
 * A script the browser runs in a page's MAIN world reaches the page's built-ins: a page that
 * has patched `fetch`, `Response.prototype.blob`, `createImageBitmap`, a canvas's `toBlob` or
 * `btoa` sees the script's calls and chooses what they return – the bytes the search uploads
 * under the user's engine session would be the page's to pick. An isolated world of the
 * browser's own has none of that: its globals and prototypes are the engine's, never touched by
 * the page or by any extension (each content script and user script has a world of its own),
 * while the document, its origin, its cookies, its referrer policy and its CSP are the page's –
 * the fetch is still the page's own request. Chrome's image search reads the renderer's
 * decoded bitmap through the browser process and runs no script in the page at all; a world of
 * our own is the nearest an embedder's API offers, and the desktop runs EVERY thumbnail script
 * there: `webContents.executeJavaScriptInIsolatedWorld` for the top frame, and the frame's own
 * preload for a sub-frame (`webFrame.executeJavaScriptInIsolatedWorld`, the same id), since
 * Electron 44's `WebFrameMain` evaluates in the main world only. The phone's WebView evaluates
 * in the main world only (`evaluateJavascript`); its script is the page's to observe, and the
 * matrix says so.
 *
 * The id. Electron's `executeJavaScriptInIsolatedWorld` takes 1..536 870 911 (Blink's embedder
 * range, below `kEmbedderWorldIdLimit = 1 << 29`; the engine's own worlds – DevTools',
 * workers' – sit above it). Of that range, Chromium's extension content scripts take ids
 * counting up from 1 (one per extension, allotted by the extensions renderer), Electron's
 * `contextIsolation` preload world is 999, Zenium's user-script worlds count up from 100 000
 * (`preload/userScripts.ts` `FIRST_USER_SCRIPT_WORLD_ID`, one per extension and world), and
 * Electron's retired content-script band began at 1 << 20. `1 << 28`, the floor of the range's
 * upper half, is above every one of them and is allotted to nothing else; no `setIsolatedWorldInfo`
 * is given, so the world keeps the document's origin and CSP.
 */
export const IMAGE_THUMBNAIL_WORLD_ID = 1 << 28

/** Electron's bounds for a world id an embedder may name (`executeJavaScriptInIsolatedWorld`). */
export const EMBEDDER_WORLD_ID_MIN = 1
export const EMBEDDER_WORLD_ID_MAX = (1 << 29) - 1

/**
 * The wire between the desktop host and a page frame's preload for a script in a sub-frame's
 * private world: the host sends an execution down the frame (`WebFrameMain.send`), the preload
 * runs it in the named world and answers under the token.
 */
export const PRIVATE_WORLD_CHANNELS = {
  /** Host → one frame: run `code` in the frame's private world. */
  execute: 'zen:private-world-execute',
  /** Frame → host: the execution's outcome, by token. */
  answer: 'zen:private-world-answer'
} as const

export interface PrivateWorldExecution {
  token: number
  /** The world to run in; the preload runs `IMAGE_THUMBNAIL_WORLD_ID` and nothing else. */
  worldId: number
  /** One expression (an async IIFE): its settled value is the answer. */
  code: string
}

export interface PrivateWorldAnswer {
  token: number
  /** The script's settled value (plain data; the world's objects are copied out). */
  result?: unknown
  /** Why there is none: the script threw, or the world refused it. */
  error?: string
}

/** A host's execution request as it comes off the wire, or null for anything else. */
export function readPrivateWorldExecution(raw: unknown): PrivateWorldExecution | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { token, worldId, code } = raw as Record<string, unknown>
  if (!Number.isInteger(token) || !Number.isInteger(worldId) || typeof code !== 'string')
    return null
  return { token: token as number, worldId: worldId as number, code }
}

/** A frame's answer as it comes off the wire, or null for anything else. */
export function readPrivateWorldAnswer(raw: unknown): PrivateWorldAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { token, result, error } = raw as Record<string, unknown>
  if (!Number.isInteger(token)) return null
  if (error !== undefined && typeof error !== 'string') return null
  return { token: token as number, ...(error !== undefined ? { error } : { result }) }
}
