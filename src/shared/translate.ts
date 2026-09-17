/**
 * Page translation: the JSON-serialisable types the core, the hosts and the chrome share.
 * Everything here crosses the IPC boundary inside an event or a command payload.
 */

/**
 * Where a tab is in the translation flow.
 * - `idle`: nothing known yet, the page is in a preferred language, or it is not translatable.
 * - `detecting`: the page language is being identified.
 * - `offered`: the page is in a foreign language and the chrome may offer to translate it.
 * - `downloading`: the model for the pair is being fetched (first use of a pair).
 * - `translating`: text is flowing through the engine.
 * - `translated`: the page shows the translation (dynamic content keeps being translated).
 * - `error`: the last attempt failed; `error` says why.
 */
export type TranslateStatus =
  'idle' | 'detecting' | 'offered' | 'downloading' | 'translating' | 'translated' | 'error'

export interface TranslateTabState {
  tabId: string
  status: TranslateStatus
  /** Page language (BCP-47 primary tag as the model registry spells it), null when unknown. */
  source: string | null
  /** Detector confidence 0..1; null when the language came from a page hint or the user. */
  confidence: number | null
  /** Language the page is (or would be) translated into. */
  target: string | null
  /** Segments finished / segments collected while translating (and after). */
  progress: { done: number; total: number } | null
  /** Bytes received / bytes expected while a model downloads. */
  download: { received: number; total: number } | null
  error: string | null
  /** The offer or translation was started by the auto-offer rules rather than the user. */
  auto: boolean
  /** The user dismissed the offer for this page load (the chrome hides its bar). */
  dismissed: boolean
}

export interface TranslatePreferences {
  /** Languages the user reads, most preferred first; the first one is the default target. */
  preferred: string[]
  /** Pages in these languages are translated without asking. */
  alwaysTranslate: string[]
  /** Pages in these languages are never offered. */
  neverTranslate: string[]
  /** Sites (registrable domains) that are never offered. */
  neverTranslateSites: string[]
  /** Offer to translate foreign-language pages when they load. */
  autoOffer: boolean
}

/** One language pair of the model registry and whether its files are on this device. */
export interface TranslateModelInfo {
  from: string
  to: string
  version: string
  /** Size of the model files in bytes (the registry's figure until downloaded). */
  bytes: number
  installed: boolean
}

export interface TranslateSelectionResult {
  text: string
  source: string | null
  target: string
  translation: string
}

export interface TranslateUIState {
  /** The host runs a translation engine (every desktop and Android build). */
  available: boolean
  preferences: TranslatePreferences
  /** Every language the registry can translate from or into, sorted. */
  languages: string[]
  /** Models downloaded to this device. */
  installed: TranslateModelInfo[]
  /** Date of the model registry in use (`YYYY-MM-DD`) and whether it came from a live refresh. */
  registryDate: string
  /** SPDX identifier of the licence the model files come under (shown next to the models). */
  modelLicense: string
  /** Per-tab state for tabs that left `idle`. */
  tabs: Record<string, TranslateTabState>
}

/**
 * What the translation script collected for language detection: the first visible text of the
 * page plus the hints the document itself gives.
 */
export interface TranslatePageSample {
  /** Token of the document the runtime is installed in (see `TranslateRuntimeStatus.doc`). */
  doc: number
  text: string
  /** `<html lang>` (or the first `lang` attribute below it), '' when absent. */
  lang: string
  /** `<meta http-equiv="content-language">`, '' when absent. */
  contentLanguage: string
  /** `<html translate="no">` or Google's `notranslate` meta: the site asked not to be translated. */
  notranslate: boolean
  /** Characters of translatable text found (capped by the sampler). */
  chars: number
}

/** One block of text the page script hands out for translation (an HTML fragment). */
export interface TranslateBatchItem {
  id: number
  html: string
}

export interface TranslateBatch {
  session: number
  items: TranslateBatchItem[]
  /** Units collected so far (grows while the mutation observer finds new content). */
  total: number
  /** Units already translated. */
  done: number
}

/** A translated block going back to the page; `null` leaves the original text in place. */
export interface TranslateTranslatedItem {
  id: number
  html: string | null
}

/** Where the page script's session stands. */
export interface TranslateRuntimeStatus {
  /**
   * Random token of the document the runtime lives in. Same-document navigations (pushState,
   * fragments) keep it; a new document gets a new runtime and a new token.
   */
  doc: number
  /** The active session (0 when none). */
  session: number
  total: number
  done: number
  /** Units collected but not handed out yet. */
  pending: number
  /** The document is going away or the session was reverted. */
  ended: boolean
}

export const TRANSLATE_PIVOT_LANGUAGE = 'en'
