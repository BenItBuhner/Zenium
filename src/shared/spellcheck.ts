/**
 * Spell checking of text fields (Chrome's Settings › Languages › Spell check): the setting the
 * core keeps, and the pure rules that turn it into the list a host checks in. Everything here is
 * shared by the core, the hosts and the chrome.
 *
 * The desktop host (Electron) runs Chromium's spellchecker per session: Hunspell dictionaries,
 * downloaded from Chromium's CDN on first use, one per language; macOS uses the system's checker
 * and its own language list. Android has no spellchecker of the browser's own – the WebView's
 * fields are checked by the system spell checker service the keyboard settings name – so the
 * host reports nothing here and the chrome shows the limit instead of a list.
 */
export interface SpellcheckSettings {
  /** Chrome's "Check the spelling of text fields". */
  enabled: boolean
  /**
   * Dictionary codes (Chromium's, `en-US`, `de`, `pt-BR`) the fields are checked in, in the
   * order the user added them. Empty means "not chosen yet": the host's UI language, when it
   * has a dictionary (`resolveSpellcheckLanguages`).
   */
  languages: string[]
}

export const DEFAULT_SPELLCHECK: SpellcheckSettings = { enabled: true, languages: [] }

/** Chrome checks in a handful of languages at most; more only slows every keystroke. */
export const SPELLCHECK_LANGUAGES_MAX = 5

/** A dictionary code the way Chromium spells them: a language, an optional region. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/

export function isSpellcheckLanguageCode(code: unknown): code is string {
  return typeof code === 'string' && LANGUAGE_CODE.test(code)
}

/** Stored settings from any version come out complete and well-typed. */
export function sanitizeSpellcheck(raw: unknown): SpellcheckSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpellcheckSettings>
  const languages: string[] = []
  if (Array.isArray(r.languages)) {
    for (const code of r.languages) {
      if (!isSpellcheckLanguageCode(code) || languages.includes(code)) continue
      languages.push(code)
      if (languages.length === SPELLCHECK_LANGUAGES_MAX) break
    }
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SPELLCHECK.enabled,
    languages
  }
}

/**
 * The dictionary of a UI locale among what the host offers: the exact code, then the language
 * with the host's first region for it (`en` → `en-US`, `de-AT` → `de`), like Chrome seeding its
 * spell check languages from the accept languages.
 */
export function dictionaryFor(locale: string, available: readonly string[]): string | null {
  if (!locale) return null
  const wanted = locale.replace('_', '-')
  const exact = available.find((code) => code.toLowerCase() === wanted.toLowerCase())
  if (exact) return exact
  const language = wanted.split('-')[0].toLowerCase()
  const sameLanguage = available.find((code) => code.split('-')[0].toLowerCase() === language)
  return sameLanguage ?? null
}

/**
 * The languages a host checks in: the chosen ones the host has a dictionary for, or – nothing
 * chosen (a fresh profile) – the dictionary of the first UI locale that has one. Never more
 * than `SPELLCHECK_LANGUAGES_MAX`; empty when the host offers nothing.
 */
export function resolveSpellcheckLanguages(
  settings: SpellcheckSettings,
  available: readonly string[],
  locales: readonly string[]
): string[] {
  const chosen = settings.languages
    .map((code) => dictionaryFor(code, available))
    .filter((code): code is string => code !== null)
  const unique = [...new Set(chosen)].slice(0, SPELLCHECK_LANGUAGES_MAX)
  if (unique.length > 0) return unique
  for (const locale of locales) {
    const code = dictionaryFor(locale, available)
    if (code) return [code]
  }
  return []
}

/** What a language's dictionary is doing on this device. */
export type SpellcheckDictionaryStatus =
  /** Chromium is fetching the Hunspell dictionary (first use of the language). */
  | 'downloading'
  /** The dictionary is on the device and in use. */
  | 'ready'
  /** The download failed (offline, the CDN refused); Chromium retries on the next start. */
  | 'failed'
  /** Nothing known yet (the language is not in use, or the host has not said). */
  | 'unknown'

/** One language the host can check in, as the Settings list shows it. */
export interface SpellcheckLanguage {
  code: string
  /** The language's name in the UI language (`English (United States)`). */
  name: string
  /** Whether the fields are checked in it right now. */
  enabled: boolean
  status: SpellcheckDictionaryStatus
}

/** The spell check state the chrome renders (`UIState.spellcheck`). */
export interface SpellcheckStatus {
  /**
   * The host runs a spellchecker of the browser's own (desktop). False on Android, where the
   * WebView's fields are checked by the system's spell checker service instead; Settings then
   * shows that limit and a way to the system's keyboard settings.
   */
  available: boolean
  /**
   * The host follows the OS's languages and ignores the list (macOS's system spellchecker):
   * the languages are shown, not chosen.
   */
  systemLanguages: boolean
  /** Every language the host has a dictionary for, the enabled ones first, then by name. */
  languages: SpellcheckLanguage[]
}

export const UNAVAILABLE_SPELLCHECK: SpellcheckStatus = {
  available: false,
  systemLanguages: false,
  languages: []
}

/** A small fallback table for hosts without `Intl.DisplayNames` (old WebViews, tests). */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  nb: 'Norwegian Bokmål',
  fi: 'Finnish',
  pl: 'Polish',
  cs: 'Czech',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  el: 'Greek',
  hu: 'Hungarian',
  ro: 'Romanian',
  hr: 'Croatian',
  sk: 'Slovak',
  sl: 'Slovenian',
  bg: 'Bulgarian',
  sr: 'Serbian',
  lt: 'Lithuanian',
  lv: 'Latvian',
  et: 'Estonian',
  ca: 'Catalan',
  af: 'Afrikaans',
  id: 'Indonesian',
  vi: 'Vietnamese',
  ko: 'Korean',
  hi: 'Hindi',
  ta: 'Tamil',
  fa: 'Persian',
  he: 'Hebrew',
  sh: 'Serbo-Croatian',
  sq: 'Albanian',
  hy: 'Armenian',
  cy: 'Welsh',
  eu: 'Basque',
  ga: 'Irish',
  gl: 'Galician'
}

/**
 * The display name of a dictionary code in `uiLocale` (`en-US` → "English (United States)",
 * `de` → "German"), the way Chrome's list labels them. `Intl.DisplayNames` where the runtime
 * has it, a short table otherwise, and the code itself as the last resort.
 */
export function spellcheckLanguageName(code: string, uiLocale = 'en'): string {
  const normalized = code.replace('_', '-')
  const IntlAny = Intl as unknown as {
    DisplayNames?: new (
      locales: string[],
      options: { type: 'language' | 'region'; languageDisplay?: 'standard' | 'dialect' }
    ) => { of(code: string): string | undefined }
  }
  if (IntlAny.DisplayNames) {
    try {
      // `standard` keeps region names spelled out ("Portuguese (Brazil)", not "Brazilian
      // Portuguese"), which is how Chrome's Languages settings list them.
      const name = new IntlAny.DisplayNames([uiLocale, 'en'], {
        type: 'language',
        languageDisplay: 'standard'
      }).of(normalized)
      if (name && name.toLowerCase() !== normalized.toLowerCase()) return name
    } catch {
      /* an unsupported code: fall through */
    }
  }
  const [language, region] = normalized.split('-')
  const base = LANGUAGE_NAMES[language.toLowerCase()]
  if (!base) return code
  return region ? `${base} (${region.toUpperCase()})` : base
}

/** The Settings list: the enabled languages first (in their order), the rest by name. */
export function orderSpellcheckLanguages(
  languages: readonly SpellcheckLanguage[]
): SpellcheckLanguage[] {
  const enabled = languages.filter((l) => l.enabled)
  const rest = languages
    .filter((l) => !l.enabled)
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
  return [...enabled, ...rest]
}

/**
 * Toggle one language of the setting: `on` adds it (at the end; a list already at the limit
 * stays as it is), off removes it. `current` is what the host checks in right now, so switching
 * a language off in a profile that never chose any (the UI-locale default) keeps the others
 * rather than emptying the list back to the default.
 */
export function withSpellcheckLanguage(
  settings: SpellcheckSettings,
  current: readonly string[],
  code: string,
  on: boolean
): SpellcheckSettings {
  const base = settings.languages.length > 0 ? settings.languages : [...current]
  const languages = base.filter((c) => c.toLowerCase() !== code.toLowerCase())
  if (on) {
    if (languages.length >= SPELLCHECK_LANGUAGES_MAX) return settings
    languages.push(code)
  }
  return { ...settings, languages }
}
