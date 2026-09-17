import { describe, expect, it } from 'vitest'
import { errorCaption, pairLabel } from '../translate'

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
