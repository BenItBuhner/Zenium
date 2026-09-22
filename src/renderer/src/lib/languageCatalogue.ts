import { languageName } from '@shared/languageNames'

/**
 * The languages Settings › Languages › Add language offers (CT-41): Chrome's accept-language
 * list (`l10n_util.cc`'s `kAcceptLanguageList`, less the handful the runtime has no name for) as
 * BCP 47 tags – the languages with their common regional variants – each named in the UI's
 * language with its own name beside it, as Chrome's picker writes "German – Deutsch". The
 * names come from `Intl.DisplayNames`, so nothing here is a string to translate.
 */
export const LANGUAGE_CATALOGUE: readonly string[] = [
  'af',
  'am',
  'ar',
  'as',
  'ast',
  'az',
  'be',
  'bg',
  'bn',
  'br',
  'bs',
  'ca',
  'ceb',
  'chr',
  'ckb',
  'co',
  'cs',
  'cy',
  'da',
  'de',
  'de-AT',
  'de-CH',
  'de-DE',
  'de-LI',
  'el',
  'en',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-IE',
  'en-IN',
  'en-NZ',
  'en-US',
  'en-ZA',
  'eo',
  'es',
  'es-419',
  'es-AR',
  'es-CL',
  'es-CO',
  'es-CR',
  'es-ES',
  'es-HN',
  'es-MX',
  'es-PE',
  'es-US',
  'es-UY',
  'es-VE',
  'et',
  'eu',
  'fa',
  'fi',
  'fil',
  'fo',
  'fr',
  'fr-CA',
  'fr-CH',
  'fr-FR',
  'fy',
  'ga',
  'gd',
  'gl',
  'gn',
  'gu',
  'ha',
  'haw',
  'he',
  'hi',
  'hmn',
  'hr',
  'ht',
  'hu',
  'hy',
  'ia',
  'id',
  'ig',
  'is',
  'it',
  'it-CH',
  'it-IT',
  'ja',
  'jv',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'ku',
  'ky',
  'la',
  'lb',
  'ln',
  'lo',
  'lt',
  'lv',
  'mg',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'nb',
  'ne',
  'nl',
  'nn',
  'no',
  'ny',
  'oc',
  'om',
  'or',
  'pa',
  'pl',
  'ps',
  'pt',
  'pt-BR',
  'pt-PT',
  'qu',
  'rm',
  'ro',
  'ru',
  'rw',
  'sd',
  'si',
  'sk',
  'sl',
  'sm',
  'sn',
  'so',
  'sq',
  'sr',
  'st',
  'su',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'ti',
  'tk',
  'tn',
  'to',
  'tr',
  'tt',
  'ug',
  'uk',
  'ur',
  'uz',
  'vi',
  'wa',
  'wo',
  'xh',
  'yi',
  'yo',
  'zh',
  'zh-CN',
  'zh-HK',
  'zh-TW',
  'zu'
]

/** One language the picker offers: its tag, its name in the UI's language, its own name when that differs. */
export interface LanguageChoice {
  value: string
  label: string
  description?: string
}

const nativeNames = new Map<string, string | null>()

/** The language's name in itself ("Deutsch (Deutschland)"); null when the runtime has none or it is the UI's name. */
export function nativeLanguageName(tag: string): string | null {
  let name = nativeNames.get(tag)
  if (name === undefined) {
    name = null
    try {
      const own = new Intl.DisplayNames([tag], { type: 'language', languageDisplay: 'standard' })
      const candidate = own.of(tag)
      if (candidate && candidate.toLowerCase() !== tag.toLowerCase()) name = candidate
    } catch {
      name = null
    }
    nativeNames.set(tag, name)
  }
  return name
}

/**
 * The catalogue less `except` (the list already chosen), each as a picker row – the name in
 * the UI's language as the label, the language's own name as the description where it says
 * something the label does not – sorted by label so the list reads alphabetically.
 */
export function languageChoices(except: readonly string[] = []): LanguageChoice[] {
  const taken = new Set(except.map((tag) => tag.toLowerCase()))
  const out: LanguageChoice[] = []
  for (const tag of LANGUAGE_CATALOGUE) {
    if (taken.has(tag.toLowerCase())) continue
    const label = languageName(tag)
    const native = nativeLanguageName(tag)
    out.push({
      value: tag,
      label,
      description: native && native.toLowerCase() !== label.toLowerCase() ? native : undefined
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'en'))
}

/** Letters and digits alone, accents stripped, lower-cased: what the filter compares. */
function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/**
 * The choices matching a typed filter: every whitespace-separated term somewhere in the name,
 * the language's own name or the tag, accents ignored ("deu" finds Deutsch, "en-gb" the tag).
 * An empty filter is every choice.
 */
export function filterLanguageChoices(
  choices: readonly LanguageChoice[],
  query: string
): LanguageChoice[] {
  const terms = foldForSearch(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...choices]
  return choices.filter((choice) => {
    const haystack = foldForSearch([choice.label, choice.description ?? '', choice.value].join(' '))
    return terms.every((term) => haystack.includes(term))
  })
}
