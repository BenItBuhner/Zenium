import { languageName } from '@shared/languageNames'

/**
 * The languages Settings › Languages › Add language offers (CT-41): Chrome's accept-language
 * list (`l10n_util.cc`'s `kAcceptLanguageList`, less the handful no runtime has a name for) as
 * BCP 47 tags – the languages with their common regional variants – each named in the UI's
 * language with its own name beside it, as Chrome's picker writes "German – Deutsch". The
 * UI-language names come from `Intl.DisplayNames`; the English name each tag carries here
 * (ICU's standard form) is the fallback where a runtime's ICU has none – Android's WebView
 * writes "as" for Assamese – so a row is always a word and never a bare tag (§9.1). The own
 * names are the table's third column, shipped with the app (§10.2: every language or none,
 * never what the runtime's ICU happens to hold – a WebView without a locale's data would write
 * some rows in the UI's language and others in their own), in CLDR's standard form for the
 * language's own locale; a language whose own name is its English name (English, Afrikaans,
 * Hausa) carries none, and its row draws one line. The translation registry's two script tags
 * (`zh-Hans`, `zh-Hant`, `core/translate/detect.ts`) are here as well, so the translate lists
 * and the reader's target picker name every language the models reach from the table too.
 * Nothing here is a string to translate: an English UI reads the runtime's name and the
 * fallback alike.
 */
const CATALOGUE: readonly (readonly [tag: string, english: string, own?: string])[] = [
  ['af', 'Afrikaans'],
  ['am', 'Amharic', 'አማርኛ'],
  ['ar', 'Arabic', 'العربية'],
  ['as', 'Assamese', 'অসমীয়া'],
  ['ast', 'Asturian', 'asturianu'],
  ['az', 'Azerbaijani', 'azərbaycan'],
  ['be', 'Belarusian', 'беларуская'],
  ['bg', 'Bulgarian', 'български'],
  ['bn', 'Bangla', 'বাংলা'],
  ['br', 'Breton', 'brezhoneg'],
  ['bs', 'Bosnian', 'bosanski'],
  ['ca', 'Catalan', 'català'],
  ['ceb', 'Cebuano'],
  ['chr', 'Cherokee', 'ᏣᎳᎩ'],
  ['ckb', 'Central Kurdish', 'کوردیی ناوەندی'],
  ['co', 'Corsican', 'corsu'],
  ['cs', 'Czech', 'čeština'],
  ['cy', 'Welsh', 'Cymraeg'],
  ['da', 'Danish', 'dansk'],
  ['de', 'German', 'Deutsch'],
  ['de-AT', 'German (Austria)', 'Deutsch (Österreich)'],
  ['de-CH', 'German (Switzerland)', 'Deutsch (Schweiz)'],
  ['de-DE', 'German (Germany)', 'Deutsch (Deutschland)'],
  ['de-LI', 'German (Liechtenstein)', 'Deutsch (Liechtenstein)'],
  ['el', 'Greek', 'Ελληνικά'],
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
  ['es', 'Spanish', 'español'],
  ['es-419', 'Spanish (Latin America)', 'español (Latinoamérica)'],
  ['es-AR', 'Spanish (Argentina)', 'español (Argentina)'],
  ['es-CL', 'Spanish (Chile)', 'español (Chile)'],
  ['es-CO', 'Spanish (Colombia)', 'español (Colombia)'],
  ['es-CR', 'Spanish (Costa Rica)', 'español (Costa Rica)'],
  ['es-ES', 'Spanish (Spain)', 'español (España)'],
  ['es-HN', 'Spanish (Honduras)', 'español (Honduras)'],
  ['es-MX', 'Spanish (Mexico)', 'español (México)'],
  ['es-PE', 'Spanish (Peru)', 'español (Perú)'],
  ['es-US', 'Spanish (United States)', 'español (Estados Unidos)'],
  ['es-UY', 'Spanish (Uruguay)', 'español (Uruguay)'],
  ['es-VE', 'Spanish (Venezuela)', 'español (Venezuela)'],
  ['et', 'Estonian', 'eesti'],
  ['eu', 'Basque', 'euskara'],
  ['fa', 'Persian', 'فارسی'],
  ['fi', 'Finnish', 'suomi'],
  ['fil', 'Filipino'],
  ['fo', 'Faroese', 'føroyskt'],
  ['fr', 'French', 'français'],
  ['fr-CA', 'French (Canada)', 'français (Canada)'],
  ['fr-CH', 'French (Switzerland)', 'français (Suisse)'],
  ['fr-FR', 'French (France)', 'français (France)'],
  ['fy', 'Western Frisian', 'Frysk'],
  ['ga', 'Irish', 'Gaeilge'],
  ['gd', 'Scottish Gaelic', 'Gàidhlig'],
  ['gl', 'Galician', 'galego'],
  ['gn', 'Guarani', 'avañeʼẽ'],
  ['gu', 'Gujarati', 'ગુજરાતી'],
  ['ha', 'Hausa'],
  ['haw', 'Hawaiian', 'ʻŌlelo Hawaiʻi'],
  ['he', 'Hebrew', 'עברית'],
  ['hi', 'Hindi', 'हिन्दी'],
  ['hmn', 'Hmong', 'Hmoob'],
  ['hr', 'Croatian', 'hrvatski'],
  ['ht', 'Haitian Creole', 'kreyòl ayisyen'],
  ['hu', 'Hungarian', 'magyar'],
  ['hy', 'Armenian', 'հայերեն'],
  ['ia', 'Interlingua'],
  ['id', 'Indonesian', 'Indonesia'],
  ['ig', 'Igbo'],
  ['is', 'Icelandic', 'íslenska'],
  ['it', 'Italian', 'italiano'],
  ['it-CH', 'Italian (Switzerland)', 'italiano (Svizzera)'],
  ['it-IT', 'Italian (Italy)', 'italiano (Italia)'],
  ['ja', 'Japanese', '日本語'],
  ['jv', 'Javanese', 'Jawa'],
  ['ka', 'Georgian', 'ქართული'],
  ['kk', 'Kazakh', 'қазақ тілі'],
  ['km', 'Khmer', 'ខ្មែរ'],
  ['kn', 'Kannada', 'ಕನ್ನಡ'],
  ['ko', 'Korean', '한국어'],
  ['ku', 'Kurdish', 'kurdî'],
  ['ky', 'Kyrgyz', 'кыргызча'],
  ['la', 'Latin', 'Latina'],
  ['lb', 'Luxembourgish', 'Lëtzebuergesch'],
  ['ln', 'Lingala', 'lingála'],
  ['lo', 'Lao', 'ລາວ'],
  ['lt', 'Lithuanian', 'lietuvių'],
  ['lv', 'Latvian', 'latviešu'],
  ['mg', 'Malagasy'],
  ['mi', 'Māori'],
  ['mk', 'Macedonian', 'македонски'],
  ['ml', 'Malayalam', 'മലയാളം'],
  ['mn', 'Mongolian', 'монгол'],
  ['mr', 'Marathi', 'मराठी'],
  ['ms', 'Malay', 'Melayu'],
  ['mt', 'Maltese', 'Malti'],
  ['my', 'Burmese', 'မြန်မာ'],
  ['nb', 'Norwegian Bokmål', 'norsk bokmål'],
  ['ne', 'Nepali', 'नेपाली'],
  ['nl', 'Dutch', 'Nederlands'],
  ['nn', 'Norwegian Nynorsk', 'norsk nynorsk'],
  ['no', 'Norwegian', 'norsk'],
  ['ny', 'Nyanja', 'Chinyanja'],
  ['oc', 'Occitan'],
  ['om', 'Oromo', 'Oromoo'],
  ['or', 'Odia', 'ଓଡ଼ିଆ'],
  ['pa', 'Punjabi', 'ਪੰਜਾਬੀ'],
  ['pl', 'Polish', 'polski'],
  ['ps', 'Pashto', 'پښتو'],
  ['pt', 'Portuguese', 'português'],
  ['pt-BR', 'Portuguese (Brazil)', 'português (Brasil)'],
  ['pt-PT', 'Portuguese (Portugal)', 'português (Portugal)'],
  ['qu', 'Quechua', 'Runasimi'],
  ['rm', 'Romansh', 'rumantsch'],
  ['ro', 'Romanian', 'română'],
  ['ru', 'Russian', 'русский'],
  ['rw', 'Kinyarwanda'],
  ['sd', 'Sindhi', 'سنڌي'],
  ['si', 'Sinhala', 'සිංහල'],
  ['sk', 'Slovak', 'slovenčina'],
  ['sl', 'Slovenian', 'slovenščina'],
  ['sm', 'Samoan', 'Gagana Sāmoa'],
  ['sn', 'Shona', 'chiShona'],
  ['so', 'Somali', 'Soomaali'],
  ['sq', 'Albanian', 'shqip'],
  ['sr', 'Serbian', 'српски'],
  ['st', 'Southern Sotho', 'Sesotho'],
  ['su', 'Sundanese', 'Basa Sunda'],
  ['sv', 'Swedish', 'svenska'],
  ['sw', 'Swahili', 'Kiswahili'],
  ['ta', 'Tamil', 'தமிழ்'],
  ['te', 'Telugu', 'తెలుగు'],
  ['tg', 'Tajik', 'тоҷикӣ'],
  ['th', 'Thai', 'ไทย'],
  ['ti', 'Tigrinya', 'ትግርኛ'],
  ['tk', 'Turkmen', 'türkmen dili'],
  ['tn', 'Tswana', 'Setswana'],
  ['to', 'Tongan', 'lea fakatonga'],
  ['tr', 'Turkish', 'Türkçe'],
  ['tt', 'Tatar', 'татар'],
  ['ug', 'Uyghur', 'ئۇيغۇرچە'],
  ['uk', 'Ukrainian', 'українська'],
  ['ur', 'Urdu', 'اردو'],
  ['uz', 'Uzbek', 'oʻzbek'],
  ['vi', 'Vietnamese', 'Tiếng Việt'],
  ['wa', 'Walloon', 'walon'],
  ['wo', 'Wolof'],
  ['xh', 'Xhosa', 'isiXhosa'],
  ['yi', 'Yiddish', 'ייִדיש'],
  ['yo', 'Yoruba', 'Èdè Yorùbá'],
  ['zh', 'Chinese', '中文'],
  ['zh-CN', 'Chinese (China)', '中文（中国）'],
  ['zh-Hans', 'Chinese (Simplified)', '简体中文'],
  ['zh-Hant', 'Chinese (Traditional)', '繁體中文'],
  ['zh-HK', 'Chinese (Hong Kong SAR China)', '中文（中國香港特別行政區）'],
  ['zh-TW', 'Chinese (Taiwan)', '中文（台灣）'],
  ['zu', 'Zulu', 'isiZulu']
]

/** The catalogue's tags in Chrome's order. */
export const LANGUAGE_CATALOGUE: readonly string[] = CATALOGUE.map(([tag]) => tag)

const ENGLISH = new Map(CATALOGUE.map(([tag, english]) => [tag.toLowerCase(), english]))
const OWN = new Map(
  CATALOGUE.flatMap(([tag, , own]) => (own ? [[tag.toLowerCase(), own] as const] : []))
)

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

/**
 * The language's name in itself from the shipped table ("Deutsch (Deutschland)"); null for a
 * language whose own name is its English one (English) and for a tag outside the catalogue –
 * never the runtime's ICU, whose coverage differs by device (§10.2).
 */
export function nativeLanguageName(tag: string): string | null {
  return OWN.get(tag.toLowerCase()) ?? null
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

/**
 * The translator's languages (`state.translate.languages`, less a list's own) as picker rows
 * of the same form: the runtime's name (`languageName`, the catalogue's English where it has
 * none) over the shipped own name where that says something the label does not, sorted by
 * label. A code the runtime and the catalogue both fail to name keeps the runtime's word for
 * it, as the translate bar does.
 */
export function translateLanguageChoices(codes: readonly string[]): LanguageChoice[] {
  return codes
    .map((code): LanguageChoice => {
      const label = catalogueLanguageName(code) ?? languageName(code)
      const native = nativeLanguageName(code)
      return {
        value: code,
        label,
        description: native && native.toLowerCase() !== label.toLowerCase() ? native : undefined
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'en'))
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
