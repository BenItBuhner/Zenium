import type { TranslatePreferences } from '../../shared/translate'
import { TRANSLATE_PIVOT_LANGUAGE } from '../../shared/translate'
import { getDomain } from '../../shared/url'
import { normalizeLanguageTag } from './detect'

/**
 * The user's language preferences: which languages they read (the first one is the default
 * target), which ones to translate without asking, which ones and which sites to leave alone.
 */

/** Distinct registry codes for a list of locale tags, in order. */
export function languagesFromLocales(locales: readonly string[]): string[] {
  const out: string[] = []
  for (const locale of locales) {
    const code = normalizeLanguageTag(locale)
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

/** Preferences for a fresh profile: the UI locales the user reads, offers on. */
export function defaultPreferences(locales: readonly string[]): TranslatePreferences {
  const preferred = languagesFromLocales(locales)
  return {
    preferred: preferred.length > 0 ? preferred : [TRANSLATE_PIVOT_LANGUAGE],
    alwaysTranslate: [],
    neverTranslate: [],
    neverTranslateSites: [],
    autoOffer: true
  }
}

function languageList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const code = normalizeLanguageTag(item)
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

function siteList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const site = item.trim().toLowerCase()
    if (site && !out.includes(site)) out.push(site)
  }
  return out
}

/** Bring a stored or client-sent document into shape; anything missing comes from `fallback`. */
export function sanitizePreferences(
  raw: unknown,
  fallback: TranslatePreferences
): TranslatePreferences {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const preferred = languageList(source.preferred)
  const always = languageList(source.alwaysTranslate)
  const never = languageList(source.neverTranslate)
  const prefs: TranslatePreferences = {
    preferred: preferred.length > 0 ? preferred : [...fallback.preferred],
    // A language cannot be both translated automatically and never offered; "never" wins.
    alwaysTranslate: always.filter((code) => !never.includes(code)),
    neverTranslate: never,
    neverTranslateSites: siteList(source.neverTranslateSites),
    autoOffer: typeof source.autoOffer === 'boolean' ? source.autoOffer : fallback.autoOffer
  }
  // Nothing the user reads needs translating.
  prefs.alwaysTranslate = prefs.alwaysTranslate.filter((code) => !prefs.preferred.includes(code))
  return prefs
}

/** The site key of a page URL for the never-translate-site list ('' for non-web pages). */
export function siteOf(url: string): string {
  if (!/^https?:\/\//i.test(url)) return ''
  return getDomain(url)
}

export function isPreferred(prefs: TranslatePreferences, language: string): boolean {
  return prefs.preferred.includes(language)
}

/**
 * The language a page in `source` is translated into: the first preferred language that differs
 * from the source, then English (the pivot every model reaches), then the first preferred one.
 */
export function defaultTarget(prefs: TranslatePreferences, source: string | null): string {
  const other = prefs.preferred.find((code) => code !== source)
  if (other) return other
  if (source !== TRANSLATE_PIVOT_LANGUAGE) return TRANSLATE_PIVOT_LANGUAGE
  return prefs.preferred[0] ?? TRANSLATE_PIVOT_LANGUAGE
}

export type OfferDecision = 'translate' | 'offer' | 'none'

/**
 * What to do when a page in `language` (null = unknown) loads on `site`: translate it without
 * asking, offer to, or stay quiet. Rules, in order: unknown or preferred languages and sites or
 * languages on a never list stay quiet; always-translate languages translate; otherwise the
 * auto-offer setting decides.
 */
export function offerFor(
  prefs: TranslatePreferences,
  language: string | null,
  site: string
): OfferDecision {
  if (!language) return 'none'
  if (isPreferred(prefs, language)) return 'none'
  if (site && prefs.neverTranslateSites.includes(site)) return 'none'
  if (prefs.neverTranslate.includes(language)) return 'none'
  if (prefs.alwaysTranslate.includes(language)) return 'translate'
  return prefs.autoOffer ? 'offer' : 'none'
}

export type LanguageRule = 'always' | 'never' | 'ask'

/** Put `language` on the always list, the never list, or neither (the lists stay exclusive). */
export function withLanguageRule(
  prefs: TranslatePreferences,
  language: string,
  rule: LanguageRule
): TranslatePreferences {
  const always = prefs.alwaysTranslate.filter((code) => code !== language)
  const never = prefs.neverTranslate.filter((code) => code !== language)
  if (rule === 'always') always.push(language)
  if (rule === 'never') never.push(language)
  return { ...prefs, alwaysTranslate: always, neverTranslate: never }
}

export function languageRule(prefs: TranslatePreferences, language: string): LanguageRule {
  if (prefs.alwaysTranslate.includes(language)) return 'always'
  if (prefs.neverTranslate.includes(language)) return 'never'
  return 'ask'
}

export function withSiteRule(
  prefs: TranslatePreferences,
  site: string,
  never: boolean
): TranslatePreferences {
  const sites = prefs.neverTranslateSites.filter((s) => s !== site)
  if (never && site) sites.push(site)
  return { ...prefs, neverTranslateSites: sites }
}

/** Move `language` to the front of the preferred list (adding it when new). */
export function withPreferred(
  prefs: TranslatePreferences,
  preferred: string[]
): TranslatePreferences {
  const list = languageList(preferred)
  if (list.length === 0) return prefs
  return sanitizePreferences({ ...prefs, preferred: list }, prefs)
}
