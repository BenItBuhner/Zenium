import { describe, expect, it } from 'vitest'
import type { TranslatePageSample } from '../../../shared/translate'
import type { DetectionResult } from '../../../shared/translateEngine'
import {
  chineseScript,
  decideLanguage,
  MIN_SAMPLE_CHARS,
  normalizeLanguageTag,
  pageHint,
  registryCodeForLabel
} from '../detect'

const SUPPORTED = new Set(['en', 'es', 'de', 'fr', 'nb', 'pt', 'zh-Hans', 'zh-Hant', 'hr', 'ar'])

function sample(overrides: Partial<TranslatePageSample> = {}): TranslatePageSample {
  const text = overrides.text ?? 'x'.repeat(200)
  return {
    doc: 1,
    text,
    lang: '',
    contentLanguage: '',
    notranslate: false,
    chars: text.length,
    ...overrides
  }
}

function detection(
  language: string,
  confidence: number,
  second: DetectionResult['second'] = null
): DetectionResult {
  return { language, confidence, second }
}

describe('normalizeLanguageTag', () => {
  it('reduces BCP-47 tags to the registry spelling', () => {
    expect(normalizeLanguageTag('pt-BR')).toBe('pt')
    expect(normalizeLanguageTag('en_US')).toBe('en')
    expect(normalizeLanguageTag(' DE ')).toBe('de')
    expect(normalizeLanguageTag('ast')).toBe('ast')
  })

  it('splits Chinese by script and maps legacy codes', () => {
    expect(normalizeLanguageTag('zh')).toBe('zh-Hans')
    expect(normalizeLanguageTag('zh-CN')).toBe('zh-Hans')
    expect(normalizeLanguageTag('zh-Hans-CN')).toBe('zh-Hans')
    expect(normalizeLanguageTag('zh-TW')).toBe('zh-Hant')
    expect(normalizeLanguageTag('zh-Hant-HK')).toBe('zh-Hant')
    expect(normalizeLanguageTag('zh-HK')).toBe('zh-Hant')
    expect(normalizeLanguageTag('iw')).toBe('he')
    expect(normalizeLanguageTag('in')).toBe('id')
    expect(normalizeLanguageTag('no')).toBe('nb')
  })

  it('rejects garbage', () => {
    expect(normalizeLanguageTag('')).toBeNull()
    expect(normalizeLanguageTag('x')).toBeNull()
    expect(normalizeLanguageTag('english')).toBeNull()
    expect(normalizeLanguageTag('12')).toBeNull()
    expect(normalizeLanguageTag('-')).toBeNull()
  })
})

describe('pageHint', () => {
  it('prefers the html lang attribute, then Content-Language', () => {
    expect(pageHint({ lang: 'es-MX', contentLanguage: 'de' })).toBe('es')
    expect(pageHint({ lang: '', contentLanguage: 'de-AT, en' })).toBe('de')
    expect(pageHint({ lang: 'nonsense', contentLanguage: 'fr' })).toBe('fr')
    expect(pageHint({ lang: '', contentLanguage: '' })).toBeNull()
  })
})

describe('registryCodeForLabel', () => {
  it('maps lid.176 labels to registry codes', () => {
    expect(registryCodeForLabel('en')).toBe('en')
    expect(registryCodeForLabel('NO')).toBe('nb')
    expect(registryCodeForLabel('sh')).toBe('hr')
    expect(registryCodeForLabel('arz')).toBe('ar')
    expect(registryCodeForLabel('yue')).toBe('zh-Hant')
  })

  it('tells the Chinese scripts apart by their characters', () => {
    expect(chineseScript('我们这个国家的发展')).toBe('zh-Hans')
    expect(chineseScript('我們這個國家的發展')).toBe('zh-Hant')
    expect(chineseScript('你好')).toBe('zh-Hans')
    expect(registryCodeForLabel('zh', '學生們說')).toBe('zh-Hant')
    expect(registryCodeForLabel('zh', '学生们说')).toBe('zh-Hans')
  })
})

describe('decideLanguage', () => {
  it('trusts a certain detector even against the page hint', () => {
    const decision = decideLanguage(sample({ lang: 'en' }), detection('es', 0.97), SUPPORTED)
    expect(decision).toEqual({ language: 'es', confidence: 0.97, source: 'detector' })
  })

  it('needs a clear margin below certainty to overrule a hint', () => {
    const contested = decideLanguage(
      sample({ lang: 'pt' }),
      detection('es', 0.8, { language: 'pt', confidence: 0.7 }),
      SUPPORTED
    )
    expect(contested.language).toBe('pt')
    expect(contested.source).toBe('hint')
    const clear = decideLanguage(
      sample({ lang: 'pt' }),
      detection('es', 0.8, { language: 'pt', confidence: 0.1 }),
      SUPPORTED
    )
    expect(clear.language).toBe('es')
    expect(clear.source).toBe('detector')
  })

  it('accepts a hesitant detector that agrees with the hint', () => {
    const decision = decideLanguage(sample({ lang: 'de' }), detection('de', 0.45), SUPPORTED)
    expect(decision).toEqual({ language: 'de', confidence: 0.45, source: 'detector' })
    const alone = decideLanguage(sample(), detection('de', 0.45), SUPPORTED)
    expect(alone.language).toBeNull()
    const standalone = decideLanguage(sample(), detection('de', 0.65), SUPPORTED)
    expect(standalone.language).toBe('de')
  })

  it('falls back to the hint for short samples and unsupported labels', () => {
    const short = decideLanguage(
      sample({ lang: 'fr', text: 'Bonjour', chars: MIN_SAMPLE_CHARS - 1 }),
      detection('es', 0.99),
      SUPPORTED
    )
    expect(short).toEqual({ language: 'fr', confidence: null, source: 'hint' })
    const unsupported = decideLanguage(sample({ lang: 'de' }), detection('eo', 0.99), SUPPORTED)
    expect(unsupported.language).toBe('de')
    const nothing = decideLanguage(sample(), detection('eo', 0.99), SUPPORTED)
    expect(nothing).toEqual({ language: null, confidence: null, source: null })
    expect(decideLanguage(sample(), null, SUPPORTED).language).toBeNull()
  })

  it('keeps a confident detector on a very short page only when the hint agrees or is absent', () => {
    const shortPage = sample({ lang: 'en', text: 'Hola a todos los amigos', chars: 24 })
    expect(decideLanguage(shortPage, detection('es', 0.95), SUPPORTED).language).toBe('en')
    expect(decideLanguage({ ...shortPage, lang: '' }, detection('es', 0.95), SUPPORTED)).toEqual({
      language: 'es',
      confidence: 0.95,
      source: 'detector'
    })
  })

  it('resolves Chinese detections to a script using the sample text', () => {
    const traditional = sample({ text: '學生們說這是一個很好的開始。'.repeat(5) })
    expect(decideLanguage(traditional, detection('zh', 0.99), SUPPORTED).language).toBe('zh-Hant')
    const simplified = sample({ text: '学生们说这是一个很好的开始。'.repeat(5) })
    expect(decideLanguage(simplified, detection('zh', 0.99), SUPPORTED).language).toBe('zh-Hans')
  })
})
