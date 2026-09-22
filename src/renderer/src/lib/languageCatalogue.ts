import { languageName } from '@shared/languageNames'

/**
 * The languages Settings › Languages › Add language offers (CT-41): Chrome's accept-language
 * list (`l10n_util.cc`'s `kAcceptLanguageList`, less the handful no runtime has a name for) as
 * BCP 47 tags – the languages with their common regional variants – each named in the UI's
 * language with its own name beside it, as Chrome's picker writes "German – Deutsch". The
 * names come from `Intl.DisplayNames`; the English name each tag carries here (ICU's standard
 * form) is the fallback where a runtime's ICU has none – Android's WebView writes "as" for
 * Assamese – so a row is always a word and never a bare tag (§9.1). Nothing here is a string
 * to translate: an English UI reads the runtime's name and the fallback alike.
 */
const CATALOGUE: readonly (readonly [tag: string, english: string])[] = [
  ['af', 'Afrikaans'],
  ['am', 'Amharic'],
  ['ar', 'Arabic'],
  ['as', 'Assamese'],
  ['ast', 'Asturian'],
  ['az', 'Azerbaijani'],
  ['be', 'Belarusian'],
  ['bg', 'Bulgarian'],
  ['bn', 'Bangla'],
  ['br', 'Breton'],
  ['bs', 'Bosnian'],
  ['ca', 'Catalan'],
  ['ceb', 'Cebuano'],
  ['chr', 'Cherokee'],
  ['ckb', 'Central Kurdish'],
  ['co', 'Corsican'],
  ['cs', 'Czech'],
  ['cy', 'Welsh'],
  ['da', 'Danish'],
  ['de', 'German'],
  ['de-AT', 'German (Austria)'],
  ['de-CH', 'German (Switzerland)'],
  ['de-DE', 'German (Germany)'],
  ['de-LI', 'German (Liechtenstein)'],
  ['el', 'Greek'],
  ['en', 'English'],
  ['en-AU', 'English (Australia)'],
  ['en-CA', 'English (Canada)'],
  ['en-GB', 'English (United Kingdom)'],
  ['en-IE', 'English (Ireland)'],
  ['en-IN', 'English (India)'],
  ['en-NZ', 'English (New Zealand)'],
  ['en-US', 'English (United States)'],
  ['en-ZA', 'English (South Africa)'],
  ['eo', 'Esperanto'],
  ['es', 'Spanish'],
  ['es-419', 'Spanish (Latin America)'],
  ['es-AR', 'Spanish (Argentina)'],
  ['es-CL', 'Spanish (Chile)'],
  ['es-CO', 'Spanish (Colombia)'],
  ['es-CR', 'Spanish (Costa Rica)'],
  ['es-ES', 'Spanish (Spain)'],
  ['es-HN', 'Spanish (Honduras)'],
  ['es-MX', 'Spanish (Mexico)'],
  ['es-PE', 'Spanish (Peru)'],
  ['es-US', 'Spanish (United States)'],
  ['es-UY', 'Spanish (Uruguay)'],
  ['es-VE', 'Spanish (Venezuela)'],
  ['et', 'Estonian'],
  ['eu', 'Basque'],
  ['fa', 'Persian'],
  ['fi', 'Finnish'],
  ['fil', 'Filipino'],
  ['fo', 'Faroese'],
  ['fr', 'French'],
  ['fr-CA', 'French (Canada)'],
  ['fr-CH', 'French (Switzerland)'],
  ['fr-FR', 'French (France)'],
  ['fy', 'Western Frisian'],
  ['ga', 'Irish'],
  ['gd', 'Scottish Gaelic'],
  ['gl', 'Galician'],
  ['gn', 'Guarani'],
  ['gu', 'Gujarati'],
  ['ha', 'Hausa'],
  ['haw', 'Hawaiian'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hmn', 'Hmong'],
  ['hr', 'Croatian'],
  ['ht', 'Haitian Creole'],
  ['hu', 'Hungarian'],
  ['hy', 'Armenian'],
  ['ia', 'Interlingua'],
  ['id', 'Indonesian'],
  ['ig', 'Igbo'],
  ['is', 'Icelandic'],
  ['it', 'Italian'],
  ['it-CH', 'Italian (Switzerland)'],
  ['it-IT', 'Italian (Italy)'],
  ['ja', 'Japanese'],
  ['jv', 'Javanese'],
  ['ka', 'Georgian'],
  ['kk', 'Kazakh'],
  ['km', 'Khmer'],
  ['kn', 'Kannada'],
  ['ko', 'Korean'],
  ['ku', 'Kurdish'],
  ['ky', 'Kyrgyz'],
  ['la', 'Latin'],
  ['lb', 'Luxembourgish'],
  ['ln', 'Lingala'],
  ['lo', 'Lao'],
  ['lt', 'Lithuanian'],
  ['lv', 'Latvian'],
  ['mg', 'Malagasy'],
  ['mi', 'Māori'],
  ['mk', 'Macedonian'],
  ['ml', 'Malayalam'],
  ['mn', 'Mongolian'],
  ['mr', 'Marathi'],
  ['ms', 'Malay'],
  ['mt', 'Maltese'],
  ['my', 'Burmese'],
  ['nb', 'Norwegian Bokmål'],
  ['ne', 'Nepali'],
  ['nl', 'Dutch'],
  ['nn', 'Norwegian Nynorsk'],
  ['no', 'Norwegian'],
  ['ny', 'Nyanja'],
  ['oc', 'Occitan'],
  ['om', 'Oromo'],
  ['or', 'Odia'],
  ['pa', 'Punjabi'],
  ['pl', 'Polish'],
  ['ps', 'Pashto'],
  ['pt', 'Portuguese'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['qu', 'Quechua'],
  ['rm', 'Romansh'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['rw', 'Kinyarwanda'],
  ['sd', 'Sindhi'],
  ['si', 'Sinhala'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['sm', 'Samoan'],
  ['sn', 'Shona'],
  ['so', 'Somali'],
  ['sq', 'Albanian'],
  ['sr', 'Serbian'],
  ['st', 'Southern Sotho'],
  ['su', 'Sundanese'],
  ['sv', 'Swedish'],
  ['sw', 'Swahili'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['tg', 'Tajik'],
  ['th', 'Thai'],
  ['ti', 'Tigrinya'],
  ['tk', 'Turkmen'],
  ['tn', 'Tswana'],
  ['to', 'Tongan'],
  ['tr', 'Turkish'],
  ['tt', 'Tatar'],
  ['ug', 'Uyghur'],
  ['uk', 'Ukrainian'],
  ['ur', 'Urdu'],
  ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'],
  ['wa', 'Walloon'],
  ['wo', 'Wolof'],
  ['xh', 'Xhosa'],
  ['yi', 'Yiddish'],
  ['yo', 'Yoruba'],
  ['zh', 'Chinese'],
  ['zh-CN', 'Chinese (China)'],
  ['zh-HK', 'Chinese (Hong Kong SAR China)'],
  ['zh-TW', 'Chinese (Taiwan)'],
  ['zu', 'Zulu']
]

/** The catalogue's tags in Chrome's order. */
export const LANGUAGE_CATALOGUE: readonly string[] = CATALOGUE.map(([tag]) => tag)

const ENGLISH = new Map(CATALOGUE.map(([tag, english]) => [tag.toLowerCase(), english]))

/**
 * The name of `tag` in the UI's language: the runtime's (`languageName`) when it has one, the
 * catalogue's English one when it has not, null for a tag outside the catalogue that the
 * runtime cannot name either – never the tag itself.
 */
export function catalogueLanguageName(tag: string): string | null {
  const name = languageName(tag)
  if (name && name.toLowerCase() !== tag.toLowerCase()) return name
  return ENGLISH.get(tag.toLowerCase()) ?? null
}

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
 * something the label does not – sorted by label so the list reads alphabetically. A tag
 * nothing names (none today: every tag carries its English name) is left out rather than
 * offered as itself.
 */
export function languageChoices(except: readonly string[] = []): LanguageChoice[] {
  const taken = new Set(except.map((tag) => tag.toLowerCase()))
  const out: LanguageChoice[] = []
  for (const tag of LANGUAGE_CATALOGUE) {
    if (taken.has(tag.toLowerCase())) continue
    const label = catalogueLanguageName(tag)
    if (!label) continue
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
