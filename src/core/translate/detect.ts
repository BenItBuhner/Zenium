import type { TranslatePageSample } from '../../shared/translate'
import type { DetectionResult } from '../../shared/translateEngine'

/**
 * Language identification for pages: fastText's lid.176 labels and the document's own hints
 * (`<html lang>`, `<meta http-equiv="content-language">`) are reconciled into one of the codes the
 * model registry speaks (BCP-47 primary tags, `zh-Hans` / `zh-Hant` for Chinese).
 */

/** Labels of lid.176 whose registry code differs (dialects and close relatives map to the nearest model). */
const LABEL_TO_REGISTRY: Record<string, string> = {
  no: 'nb',
  sh: 'hr',
  arz: 'ar',
  als: 'de',
  bar: 'de',
  nds: 'de',
  an: 'es',
  ast: 'es',
  eml: 'it',
  lmo: 'it',
  nap: 'it',
  pms: 'it',
  scn: 'it',
  vec: 'it',
  yue: 'zh-Hant',
  wuu: 'zh-Hans'
}

/** Legacy ISO 639 codes browsers still emit. */
const LEGACY_TAGS: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', no: 'nb', mo: 'ro' }

/** Traditional-only characters and their simplified forms, for telling the two Chinese scripts apart. */
const TRADITIONAL =
  '國們這為說時會來學對開關電長門問間車東馬點發經過還進裡後讓與書體從現業應該當語幾麼樣種將認識覽見觀聽寫讀'
const SIMPLIFIED =
  '国们这为说时会来学对开关电长门问间车东马点发经过还进里后让与书体从现业应该当语几么样种将认识览见观听写读'

/** Which Chinese script a text is written in; simplified when nothing distinguishes them. */
export function chineseScript(text: string): 'zh-Hans' | 'zh-Hant' {
  let traditional = 0
  let simplified = 0
  for (const char of text) {
    if (TRADITIONAL.includes(char)) traditional++
    else if (SIMPLIFIED.includes(char)) simplified++
  }
  return traditional > simplified ? 'zh-Hant' : 'zh-Hans'
}

/** The registry code for a lid.176 label (`zh` is split by script using `text`). */
export function registryCodeForLabel(label: string, text = ''): string {
  const lower = label.toLowerCase()
  if (lower === 'zh') return chineseScript(text)
  return LABEL_TO_REGISTRY[lower] ?? lower
}

/**
 * Reduce a BCP-47 tag (`pt-BR`, `zh-TW`, `en_US`) to the registry's spelling; null for garbage.
 * Region and variant subtags are dropped: the models are per language, Chinese per script.
 */
export function normalizeLanguageTag(tag: string): string | null {
  const parts = tag.trim().replace(/_/g, '-').toLowerCase().split('-').filter(Boolean)
  if (parts.length === 0) return null
  const primary = parts[0]
  if (!/^[a-z]{2,3}$/.test(primary)) return null
  const language = LEGACY_TAGS[primary] ?? primary
  if (language === 'zh') {
    const rest = parts.slice(1)
    if (rest.includes('hant') || rest.includes('tw') || rest.includes('hk') || rest.includes('mo'))
      return 'zh-Hant'
    return 'zh-Hans'
  }
  return language
}

/** The first usable hint of a page: `<html lang>` first, then the Content-Language meta. */
export function pageHint(
  sample: Pick<TranslatePageSample, 'lang' | 'contentLanguage'>
): string | null {
  for (const raw of [sample.lang, sample.contentLanguage]) {
    // Content-Language may list several languages; the first one is the document's.
    const first = raw.split(',')[0] ?? ''
    const normalized = normalizeLanguageTag(first)
    if (normalized) return normalized
  }
  return null
}

/** A sample shorter than this says nothing by itself. */
export const MIN_SAMPLE_CHARS = 20
/** From here on the detector overrules a contradicting page hint. */
const OVERRULE_CHARS = 40
const CONFIDENT = 0.75
const CONFIDENT_MARGIN = 0.25
const CERTAIN = 0.9
/** Without a hint, this much is needed to act on the detector alone. */
const STANDALONE = 0.6
/** With an agreeing hint, this much suffices. */
const AGREEMENT = 0.4

export interface LanguageDecision {
  /** Registry code of the page language, or null when unknown. */
  language: string | null
  /** Detector probability when the decision rests on it, null when it came from a hint. */
  confidence: number | null
  source: 'detector' | 'hint' | null
}

/**
 * Reconcile the detector's answer with the page's hints. Sites mislabel `lang` often enough that
 * a confident detector wins; a hesitant one is checked against the hint, and short samples fall
 * back to the hint entirely.
 */
export function decideLanguage(
  sample: TranslatePageSample,
  detection: DetectionResult | null,
  supported: ReadonlySet<string>
): LanguageDecision {
  const hint = pageHint(sample)
  const hintUsable = hint !== null && supported.has(hint) ? hint : null
  const detected =
    detection && detection.language ? registryCodeForLabel(detection.language, sample.text) : null
  const detectedUsable = detected !== null && supported.has(detected) ? detected : null
  const confidence = detection?.confidence ?? 0
  const margin = detection?.second ? confidence - detection.second.confidence : confidence
  const chars = Math.max(sample.chars, sample.text.length)

  if (detectedUsable && chars >= MIN_SAMPLE_CHARS) {
    const confident =
      confidence >= CERTAIN || (confidence >= CONFIDENT && margin >= CONFIDENT_MARGIN)
    if (confident && (chars >= OVERRULE_CHARS || !hintUsable || hintUsable === detectedUsable))
      return { language: detectedUsable, confidence, source: 'detector' }
    if (hintUsable === detectedUsable && confidence >= AGREEMENT)
      return { language: detectedUsable, confidence, source: 'detector' }
    if (!hintUsable && confidence >= STANDALONE)
      return { language: detectedUsable, confidence, source: 'detector' }
  }
  if (hintUsable) return { language: hintUsable, confidence: null, source: 'hint' }
  return { language: null, confidence: null, source: null }
}
