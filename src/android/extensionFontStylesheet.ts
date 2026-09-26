/**
 * The WebView's approximation of Chrome's per-script font preferences and its `math` family
 * (`chrome.fontSettings` with a `script` other than `Zyyy`, or `genericFamily: 'math'`):
 * `android.webkit.WebSettings` has no per-script setters and no `math` family setter, and the
 * app has no DevTools-protocol door into its WebViews (the desktop's `Page.setFontFamilies`
 * `forScripts` path). So the layer's per-script faces go to every page as a stylesheet at
 * document start – a `<style>` the runtime's Kotlin host inserts (`Extensions.kt`,
 * `ext.fonts.apply`), its text replaced in place on every layer change – with the rules inside
 * a named cascade layer, `@layer zen-ext-fonts`: unlayered author declarations beat a layered
 * one, so a face the page names stands and only text it leaves to the default takes ours, the
 * precedence Chrome's font preferences have for normal declarations.
 *
 * The selectors: `*:lang(<tag>)` for every BCP-47 tag a script's languages are written in
 * ([SCRIPT_LANGUAGE_TAGS]; `:lang()` matches a tag's subtags by prefix, so `ru` reaches
 * `ru-RU`), and `math` for MathML. The divergences from Chrome, stated with every reading of
 * this approximation: an unlabelled span (no `lang` on it or an ancestor) takes the default
 * script's face where Chrome decides per character from the text's script; a `lang`-labelled
 * span takes the script's face whether or not its characters are of that script; `math`
 * reaches MathML elements alone, where Chrome's `math` family is a generic family a page may
 * name anywhere. Chrome's 152 script codes that no living language tag is known for here
 * ([unmappedScripts]) get no rule and are listed by the round that built this.
 */
import { SCRIPT_CODES, COMMON_SCRIPT } from '@core/extensions/api/fontSettings'
import {
  GENERIC_FONT_SLOTS,
  type ExtensionFontLayer,
  type FamilyMap,
  type GenericFontSlot
} from '@shared/fonts'

/** The `<style>` element's id, the same in every document (a page may look for it; Chrome's prefs are not in the DOM at all). */
export const FONT_STYLE_ID = 'zen-ext-fonts'
export const FONT_LAYER_NAME = 'zen-ext-fonts'

/**
 * Chrome's `fontSettings.ScriptCode` → the BCP-47 tags of the languages written in the script,
 * as pages label them (`lang="…"`): the primary language subtag, and where one language is
 * written in several scripts the script-qualified tag (`sr-Cyrl`, `mn-Mong`, `zh-Hant`). Region
 * forms follow by `:lang()`'s prefix matching (`zh-TW` and `zh-HK` are named because `zh-Hant`
 * is not their prefix). Ordered as Chrome's enum is.
 */
export const SCRIPT_LANGUAGE_TAGS: Readonly<Record<string, readonly string[]>> = {
  Arab: ['ar', 'fa', 'ur', 'ps', 'ug', 'ks', 'sd', 'ckb', 'pa-Arab', 'ms-Arab'],
  Armi: ['arc'],
  Armn: ['hy'],
  Avst: ['ae'],
  Bali: ['ban'],
  Bamu: ['bax'],
  Bass: ['bsq'],
  Batk: ['bbc', 'btk'],
  Beng: ['bn', 'as', 'mni-Beng'],
  Blis: ['zbl'],
  Bopo: ['zh-Bopo'],
  Brah: ['pra-Brah', 'pi-Brah'],
  Brai: ['en-Brai', 'fr-Brai'],
  Bugi: ['bug', 'mak'],
  Buhd: ['bku'],
  Cakm: ['ccp'],
  Cans: ['cr', 'iu', 'oj', 'chp', 'nsk'],
  Cari: ['xcr'],
  Cham: ['cja', 'cjm'],
  Cher: ['chr'],
  Copt: ['cop'],
  Cprt: ['grc-Cprt'],
  Cyrl: [
    'ru',
    'uk',
    'bg',
    'be',
    'kk',
    'mk',
    'sr-Cyrl',
    'ky',
    'tg',
    'mn',
    'tt',
    'ba',
    'cv',
    'os',
    'ab',
    'kv',
    'ce',
    'sah',
    'uz-Cyrl',
    'bs-Cyrl',
    'tk-Cyrl'
  ],
  Cyrs: ['cu'],
  Deva: ['hi', 'mr', 'ne', 'sa', 'kok', 'mai', 'bho', 'awa', 'doi', 'new', 'brx', 'sat-Deva'],
  Dsrt: ['en-Dsrt'],
  Dupl: ['fr-Dupl'],
  Egyp: ['egy'],
  Elba: ['sq-Elba'],
  Ethi: ['am', 'ti', 'gez', 'byn', 'tig', 'wal'],
  Geok: ['ka-Geok'],
  Geor: ['ka'],
  Glag: ['cu-Glag'],
  Goth: ['got'],
  Gran: ['sa-Gran'],
  Grek: ['el', 'grc', 'pnt'],
  Gujr: ['gu'],
  Guru: ['pa', 'pa-Guru'],
  Hang: ['ko'],
  Hani: ['zh', 'zh-Hani', 'lzh', 'yue-Hani', 'ja-Hani'],
  Hano: ['hnn'],
  Hans: ['zh-Hans', 'zh-CN', 'zh-SG', 'yue-Hans'],
  Hant: ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'yue', 'yue-Hant'],
  Hebr: ['he', 'yi', 'lad-Hebr'],
  Hluw: ['hlu'],
  Hmng: ['hmn-Hmng', 'hnj'],
  Hung: ['hu-Hung'],
  Ital: ['ett', 'xum', 'osc'],
  Java: ['jv-Java', 'jv'],
  Jpan: ['ja'],
  Kali: ['eky', 'kyu'],
  Khar: ['pra-Khar'],
  Khmr: ['km'],
  Khoj: ['sd-Khoj'],
  Knda: ['kn', 'tcy'],
  Kpel: ['kpe-Kpel'],
  Kthi: ['bh-Kthi', 'mai-Kthi'],
  Lana: ['nod'],
  Laoo: ['lo'],
  Latf: ['de-Latf'],
  Latg: ['ga-Latg'],
  Latn: [
    'en',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'nl',
    'sv',
    'da',
    'no',
    'nb',
    'nn',
    'fi',
    'pl',
    'cs',
    'sk',
    'hu',
    'ro',
    'hr',
    'sl',
    'bs',
    'sr-Latn',
    'tr',
    'az',
    'uz',
    'tk',
    'vi',
    'id',
    'ms',
    'tl',
    'fil',
    'sw',
    'ca',
    'eu',
    'gl',
    'is',
    'et',
    'lv',
    'lt',
    'af',
    'la',
    'mt',
    'cy',
    'ga',
    'gd',
    'br',
    'sq',
    'lb',
    'fo',
    'eo',
    'haw',
    'mi',
    'sm',
    'to',
    'fj',
    'ha',
    'yo',
    'ig',
    'zu',
    'xh',
    'st',
    'tn',
    'so',
    'rw',
    'rn',
    'ln',
    'wo',
    'ff',
    'ee',
    'ak',
    'tw',
    'lg',
    'ny',
    'sn',
    'mg',
    'qu',
    'ay',
    'gn',
    'ht',
    'jv-Latn',
    'su-Latn',
    'ku',
    'ms-Latn',
    'pt-BR',
    'en-US',
    'en-GB'
  ],
  Lepc: ['lep'],
  Limb: ['lif'],
  Linb: ['gmy'],
  Lisu: ['lis'],
  Lyci: ['xlc'],
  Lydi: ['xld'],
  Mand: ['myz', 'mid'],
  Mani: ['xmn'],
  Maya: ['myn', 'emy'],
  Mend: ['men-Mend'],
  Merc: ['xmr-Merc'],
  Mero: ['xmr'],
  Mlym: ['ml'],
  Mong: ['mn-Mong', 'mnc', 'xwo'],
  Mroo: ['mro'],
  Mtei: ['mni', 'mni-Mtei'],
  Mymr: ['my', 'shn', 'mnw', 'kac-Mymr', 'ksw'],
  Narb: ['xna'],
  Nbat: ['arc-Nbat'],
  Nkoo: ['nqo', 'man-Nkoo', 'bm-Nkoo'],
  Nshu: ['zhx-Nshu'],
  Ogam: ['sga-Ogam', 'pgl'],
  Olck: ['sat', 'sat-Olck'],
  Orkh: ['otk'],
  Orya: ['or', 'sat-Orya'],
  Osma: ['so-Osma'],
  Palm: ['arc-Palm'],
  Perm: ['kv-Perm'],
  Phag: ['mn-Phag', 'zh-Phag'],
  Phli: ['pal'],
  Phlp: ['pal-Phlp'],
  Phlv: ['pal-Phlv'],
  Phnx: ['phn'],
  Plrd: ['hmd', 'hmn-Plrd'],
  Prti: ['xpr'],
  Rjng: ['rej'],
  Runr: ['non-Runr', 'ang-Runr'],
  Samr: ['smp', 'sam'],
  Sarb: ['xsa'],
  Saur: ['saz'],
  Sgnw: ['sgn'],
  Shaw: ['en-Shaw'],
  Shrd: ['sa-Shrd'],
  Sind: ['sd-Sind'],
  Sinh: ['si', 'pi-Sinh'],
  Sora: ['srb'],
  Sund: ['su', 'su-Sund'],
  Sylo: ['syl'],
  Syrc: ['syr', 'syc', 'aii', 'cld', 'tru'],
  Syre: ['syc-Syre'],
  Syrj: ['syc-Syrj'],
  Syrn: ['syc-Syrn'],
  Tagb: ['tbw'],
  Takr: ['doi-Takr'],
  Tale: ['tdd'],
  Talu: ['khb'],
  Taml: ['ta'],
  Tang: ['txg'],
  Tavt: ['blt'],
  Telu: ['te', 'gon-Telu'],
  Tfng: ['tzm', 'zgh', 'kab-Tfng', 'shi-Tfng', 'ber-Tfng'],
  Tglg: ['tl-Tglg', 'fil-Tglg'],
  Thaa: ['dv'],
  Thai: ['th', 'nod-Thai'],
  Tibt: ['bo', 'dz', 'lbj'],
  Tirh: ['mai-Tirh'],
  Ugar: ['uga'],
  Vaii: ['vai'],
  Wara: ['hoc'],
  Xpeo: ['peo'],
  Xsux: ['akk', 'sux', 'hit'],
  Yiii: ['ii'],
  Zmth: [],
  Zsym: []
}

/** Chrome's script codes (`Zyyy` aside, the common script is the WebSettings' own) with no known language tag: no rule for them. */
export function unmappedScripts(): string[] {
  return SCRIPT_CODES.filter(
    (code) => code !== COMMON_SCRIPT && (SCRIPT_LANGUAGE_TAGS[code] ?? []).length === 0
  )
}

/**
 * The one face a script's text takes: one `font-family` per `:lang()` rule, so the slots an
 * extension set for the script collapse to one – the standard family first, as Chrome's
 * "Default" for the script, then the ones a page is likelier to leave unnamed.
 */
export const SCRIPT_FACE_PRECEDENCE: readonly GenericFontSlot[] = [
  'standard',
  'sansSerif',
  'serif',
  'fixed',
  'cursive',
  'fantasy',
  'math'
]

export function scriptFace(families: FamilyMap): string | null {
  for (const slot of SCRIPT_FACE_PRECEDENCE) {
    const name = families[slot]
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  }
  for (const slot of GENERIC_FONT_SLOTS) {
    const name = families[slot]
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  }
  return null
}

/**
 * CSS's generic family keywords: written bare, so the engine resolves them as generics (a
 * quoted `"serif"` is a family named serif – the same face on Android, whose `fonts.xml` names
 * the generics, but not the keyword).
 */
const GENERIC_KEYWORDS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'math',
  'emoji',
  'fangsong',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded'
])

/** A family name as a CSS value: a generic keyword bare; any other name quoted, a quote or backslash escaped, control characters dropped. */
export function cssFamily(name: string): string {
  const lower = name.trim().toLowerCase()
  if (GENERIC_KEYWORDS.has(lower)) return lower
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\"]/g, (c) => `\\${c}`)
  return `"${clean}"`
}

function langSelector(tags: readonly string[]): string {
  return tags.map((tag) => `*:lang(${tag})`).join(', ')
}

/** How many subtags a tag has (`zh` 1, `zh-Hans` 2): the rules' order. */
function subtags(tag: string): number {
  return tag.split('-').length
}

/**
 * The stylesheet for a layer: a rule per script an extension holds a family for (with a tag
 * table entry), and `math` for the common script's math family; the empty string when the
 * layer has nothing the stylesheet can carry (the slotted common-script families and the
 * sizes are `WebSettings`' own, `ExtensionFontLayer.kt`).
 *
 * The rules' order: `:lang()` matches by subtag prefix at one specificity, so a `lang="zh-Hans"`
 * span matches Hani's `*:lang(zh)` and Hans's `*:lang(zh-Hans)` alike and the later rule wins.
 * A script's tags are split by subtag count and every one-subtag rule of every script comes
 * before every two-subtag rule (then three), so the tag that extends another is the later one
 * whatever the two scripts are (Hani's `zh` before Hans's `zh-Hans`, Hant's `yue` before Hani's
 * `yue-Hani` – no order of whole scripts satisfies both).
 */
export function fontLayerStylesheet(layer: ExtensionFontLayer | null): string {
  if (!layer) return ''
  const byLength = new Map<number, string[]>()
  const rule = (length: number, text: string): void => {
    const rules = byLength.get(length)
    if (rules) rules.push(text)
    else byLength.set(length, [text])
  }
  for (const script of Object.keys(layer.scripts).sort()) {
    if (script === COMMON_SCRIPT) continue
    const tags = SCRIPT_LANGUAGE_TAGS[script]
    if (!tags || tags.length === 0) continue
    const face = scriptFace(layer.scripts[script])
    if (face === null) continue
    const lengths = [...new Set(tags.map(subtags))].sort((a, b) => a - b)
    for (const length of lengths) {
      const group = tags.filter((tag) => subtags(tag) === length)
      rule(length, `${langSelector(group)} { font-family: ${cssFamily(face)}; }`)
    }
  }
  const rules = [...byLength.keys()].sort((a, b) => a - b).flatMap((n) => byLength.get(n) ?? [])
  const math = layer.families.math
  if (typeof math === 'string' && math.trim() !== '') {
    rules.push(`math { font-family: ${cssFamily(math.trim())}; }`)
  }
  if (rules.length === 0) return ''
  return `@layer ${FONT_LAYER_NAME} {\n${rules.map((r) => `  ${r}`).join('\n')}\n}\n`
}

/**
 * The script that puts the stylesheet into a document – at document start (registered per
 * WebView by the Kotlin host, the `<style>` appended to the root while `<head>` is not parsed
 * yet) and into an open document on a layer change (`evaluateJavascript`, the text replaced in
 * place). An empty stylesheet takes the element out. Nothing else of the page is touched, and
 * nothing is logged.
 */
export function fontStylesheetScript(css: string): string {
  const id = JSON.stringify(FONT_STYLE_ID)
  const text = JSON.stringify(css)
  return (
    `(() => { try { const id = ${id}, css = ${text}; ` +
    `const apply = () => { const root = document.documentElement; if (!root) return false; ` +
    `let el = document.getElementById(id); ` +
    `if (css === '') { if (el) el.remove(); return true; } ` +
    `if (!el) { el = document.createElementNS('http://www.w3.org/1999/xhtml', 'style'); el.id = id; (document.head || root).appendChild(el); } ` +
    `if (el.textContent !== css) el.textContent = css; return true; }; ` +
    `if (!apply()) document.addEventListener('DOMContentLoaded', apply, { once: true }); } catch {} })();`
  )
}
