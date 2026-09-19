import { describe, expect, it } from 'vitest'
import type { TranslateModelInfo } from '@shared/translate'
import { languageOptions, modelOptions, pairKey, pairLabel, errorCaption } from '../translate'
import { formatBytes } from '../utils'

describe('errorCaption', () => {
  it('is empty when the core gave no reason', () => {
    expect(errorCaption(null)).toBeNull()
    expect(errorCaption(undefined)).toBeNull()
    expect(errorCaption('   ')).toBeNull()
  })

  it("turns the hosts' network plumbing into one sentence", () => {
    for (const reason of [
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_NAME_NOT_RESOLVED',
      'TypeError: Failed to fetch',
      'Unable to resolve host "firefox-settings-attachments.cdn.mozilla.net": No address associated with hostname',
      'java.net.UnknownHostException: firefox-settings-attachments.cdn.mozilla.net'
    ]) {
      expect(errorCaption(reason)).toBe('The model server could not be reached.')
    }
  })

  it('shows every other reason as a sentence', () => {
    expect(errorCaption('the model download failed (HTTP 503)')).toBe(
      'The model download failed (HTTP 503).'
    )
    expect(errorCaption('the model file is corrupt (checksum mismatch)')).toBe(
      'The model file is corrupt (checksum mismatch).'
    )
    expect(errorCaption('Zenium has no translation model from es to de.')).toBe(
      'Zenium has no translation model from es to de.'
    )
    expect(errorCaption('This page is already in English.')).toBe(
      'This page is already in English.'
    )
  })
})

describe('pairLabel', () => {
  it('names both sides when both are known', () => {
    expect(pairLabel('es', 'en')).toBe('Spanish to English')
  })

  it('names the side that is known', () => {
    expect(pairLabel(null, 'de')).toBe('German')
    expect(pairLabel('fr', null)).toBe('French')
    expect(pairLabel(null, null)).toBe('')
  })
})

describe('languageOptions (the language menulists and picker sheets)', () => {
  it('lists the languages by name, never the other side of the pair', () => {
    expect(languageOptions(['fr', 'es', 'de'], 'es')).toEqual([
      { value: 'fr', label: 'French' },
      { value: 'de', label: 'German' }
    ])
  })

  it('leaves the labels without a second line: the popover rows have one line each', () => {
    for (const option of languageOptions(['en', 'es'])) expect(option.description).toBeUndefined()
  })
})

describe('modelOptions (Settings > Languages > download a model)', () => {
  const model = (
    from: string,
    to: string,
    extra: Partial<TranslateModelInfo> = {}
  ): TranslateModelInfo =>
    ({
      from,
      to,
      bytes: 17_000_000,
      installed: false,
      downloading: false,
      ...extra
    }) as TranslateModelInfo

  it('offers the pairs neither on the device nor on their way, by name, with their size as the description', () => {
    const options = modelOptions([
      model('es', 'en', { installed: true }),
      model('fr', 'en', { downloading: true }),
      model('de', 'en'),
      model('en', 'de', { bytes: 33_400_000 })
    ])
    expect(options.map((o) => o.value)).toEqual([pairKey({ from: 'en', to: 'de' }), 'de:en'])
    expect(options[0]).toEqual({
      value: 'en:de',
      label: 'English to German',
      description: formatBytes(33_400_000)
    })
    expect(options[1]?.description).toBe(formatBytes(17_000_000))
  })

  it("leaves out the pairs the state lists on the device or arriving, whatever the registry's kept flags say", () => {
    const options = modelOptions(
      [model('de', 'en'), model('en', 'de'), model('fr', 'en')],
      [
        { from: 'de', to: 'en' },
        { from: 'fr', to: 'en' }
      ]
    )
    expect(options.map((o) => o.value)).toEqual(['en:de'])
  })
})
