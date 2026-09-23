import { describe, expect, it } from 'vitest'
import { versionReport } from '../versionReport'

describe('versionReport', () => {
  it('states the browser’s version, the engine’s Chromium version off the user agent, and the host', () => {
    expect(
      versionReport(
        '0.4.35',
        'Android System WebView',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Mobile Safari/537.36'
      )
    ).toBe('Zenium 0.4.35 · Chromium 128.0.6613.127 · Android System WebView')
  })

  it('leaves the Chromium part out when the agent names none', () => {
    expect(versionReport('0.4.35', 'Electron', '')).toBe('Zenium 0.4.35 · Electron')
    expect(versionReport('0.4.35', 'Electron', 'Mozilla/5.0 Gecko/20100101 Firefox/130.0')).toBe(
      'Zenium 0.4.35 · Electron'
    )
  })
})
