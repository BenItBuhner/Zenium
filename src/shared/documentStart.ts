/**
 * The page preload's ONE synchronous ask of the main process at document start, before the
 * page's first script: the privacy signals, the window's display mode, the site's page-world
 * guards and the extensions' user-script plan for the frame, in one record.
 *
 * Four `sendSync` hops used to carry them (`zen:privacy-signals`, `zen:display-mode`,
 * `zen:content-guards`, `zen-ext:us-plan`), each blocking the renderer's main thread in turn;
 * #507 measured a hop on the real build at a median of ~500 µs and a p90 of 2.6–4.0 ms – the
 * cost is the round trip while the main thread is finishing the navigation's commit, not the
 * handlers – so the four became one. Every field has a safe default: a provider missing or
 * throwing on the main side (`main/platform/documentStart.ts`) leaves that field at its default
 * with the others intact, and the preload reads whatever came back through
 * {@link readDocumentStartAnswer}, so the page is never blocked on a failure.
 *
 * Android is not on this path: its document-start script is fed through the Kotlin rules path.
 */
import type { ContentGuardId } from './contentGuards'
import type { DisplayMode } from './displayMode'
import type { PrivacySignals } from './privacySignals'

/** `ipcRenderer.sendSync(DOCUMENT_START_CHANNEL, request)` → {@link DocumentStartAnswer}. */
export const DOCUMENT_START_CHANNEL = 'zen:document-start'

/**
 * What the preload sends: the document's own view of its URL (`location.href`). The user-script
 * plan prefers Chromium's word (`frame.url`) and needs the preload's exactly where the frame has
 * none yet – the initial empty document, `about:blank`, `about:srcdoc` frames, which
 * `match_about_blank` / `match_origin_as_fallback` scripts must reach.
 */
export interface DocumentStartRequest {
  url: string
}

export interface DocumentStartAnswer {
  /** `navigator.globalPrivacyControl` / `doNotTrack` for the document's kind of window. */
  signals: PrivacySignals
  /** The page's `display-mode` (MW-23): Zenium's answer for the window the page lives in. */
  displayMode: DisplayMode
  /** The page-world guards the top document's site is refused (`installContentGuards`). */
  guards: ContentGuardId[]
  /**
   * The extensions' user-script plan for the frame (`WireExtensionPlan[]` on the wire; opaque
   * here – `preload/userScripts.ts` validates it). No size cap: the scripts' code rides inline,
   * as it did in its own hop.
   */
  userScripts: unknown
}

export type DocumentStartField = keyof DocumentStartAnswer

/** The fields in the order the preload installs them – and the main side asks its providers. */
export const DOCUMENT_START_FIELDS: readonly DocumentStartField[] = [
  'signals',
  'displayMode',
  'guards',
  'userScripts'
]

const DISPLAY_MODES: readonly DisplayMode[] = ['browser', 'standalone', 'fullscreen']

/** A fresh record of the defaults: what a document gets where a provider is missing or threw. */
export function documentStartDefaults(): DocumentStartAnswer {
  return {
    signals: { gpc: false, dnt: false },
    displayMode: 'browser',
    guards: [],
    userScripts: []
  }
}

/**
 * The answer as the preload reads it: the main process's record, field by field, the default
 * for a field the record lacks or carries in the wrong shape (an ask that brought nothing at
 * all – no handler, a failed clone – reads as the defaults). The `userScripts` field is
 * carried as it came: its reader validates it.
 */
export function readDocumentStartAnswer(raw: unknown): DocumentStartAnswer {
  const answer = documentStartDefaults()
  if (!raw || typeof raw !== 'object') return answer
  const record = raw as Partial<Record<DocumentStartField, unknown>>
  const signals = record.signals
  if (signals && typeof signals === 'object') {
    const value = signals as Partial<Record<keyof PrivacySignals, unknown>>
    answer.signals = { gpc: value.gpc === true, dnt: value.dnt === true }
  }
  const displayMode = record.displayMode
  if (typeof displayMode === 'string' && (DISPLAY_MODES as readonly string[]).includes(displayMode))
    answer.displayMode = displayMode as DisplayMode
  if (Array.isArray(record.guards)) answer.guards = record.guards as ContentGuardId[]
  if ('userScripts' in record) answer.userScripts = record.userScripts
  return answer
}
