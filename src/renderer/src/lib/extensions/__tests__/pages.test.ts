import { describe, expect, it } from 'vitest'
import type { ExtensionInfo } from '@shared/types'
import { extensionPageChrome, presentedHost } from '../pages'

/*
 * What the chrome shows for a tab on an extension's page (v2 §10.1 applied to extension pages):
 * the extension's name where a host would stand, its icon in the favicon slot, and the
 * `chrome-extension://` address – for both forms the tab's URL takes: Chrome's scheme on the
 * desktop, the Android runtime's emulated origin `https://<id>.ext.zenium.invalid/…`.
 */

const ID = 'dbepggeogbaibhgnhhndojpepiihcmeb'
const ICON = 'data:image/png;base64,icon'

const ext = (patch: Partial<ExtensionInfo> = {}): ExtensionInfo =>
  ({ id: ID, name: 'Vimium', icon: ICON, enabled: true, ...patch }) as ExtensionInfo

const SCHEME_URL = `chrome-extension://${ID}/pages/options.html?tab=1#top`
const EMULATED_URL = `https://${ID}.ext.zenium.invalid/pages/options.html?tab=1#top`

describe('extensionPageChrome', () => {
  it('names the page after the extension and takes its icon, from the chrome-extension:// form', () => {
    expect(extensionPageChrome(SCHEME_URL, [ext()])).toEqual({
      id: ID,
      url: SCHEME_URL,
      name: 'Vimium',
      icon: ICON,
      extension: ext()
    })
  })

  it('reads the Android runtime’s emulated origin as the same page, presented as chrome-extension://', () => {
    const chrome = extensionPageChrome(EMULATED_URL, [ext()])
    expect(chrome?.id).toBe(ID)
    expect(chrome?.name).toBe('Vimium')
    expect(chrome?.icon).toBe(ICON)
    expect(chrome?.url).toBe(SCHEME_URL)
    expect(chrome?.url).not.toContain('.ext.zenium.invalid')
  })

  it('stands the id in for the name and the puzzle glyph for the icon while the extension is unknown', () => {
    // Removed, or not yet in the window's list: the page still reads as an extension's, never
    // as a website with a letter tile.
    for (const url of [SCHEME_URL, EMULATED_URL]) {
      expect(extensionPageChrome(url, [])).toEqual({
        id: ID,
        url: SCHEME_URL,
        name: ID,
        icon: null,
        extension: null
      })
    }
    // A blank name is no name.
    expect(extensionPageChrome(SCHEME_URL, [ext({ name: '  ' })])?.name).toBe(ID)
    // An extension without a manifest icon leaves the slot to the puzzle glyph.
    expect(extensionPageChrome(SCHEME_URL, [ext({ icon: null })])?.icon).toBeNull()
  })

  it('is null for every other address', () => {
    for (const url of [
      'https://example.com/',
      'https://dbepggeogbaibhgnhhndojpepiihcmeb.example.com/',
      'zen://settings',
      'chrome-extension://not-an-id/page.html',
      'about:blank',
      ''
    ]) {
      expect(extensionPageChrome(url, [ext()])).toBeNull()
    }
  })
})

describe('presentedHost', () => {
  it('shows the extension’s name where a row would show the host, and the host for any site', () => {
    expect(presentedHost(SCHEME_URL, [ext()])).toBe('Vimium')
    expect(presentedHost(EMULATED_URL, [ext()])).toBe('Vimium')
    expect(presentedHost(EMULATED_URL, [])).toBe(ID)
    expect(presentedHost('https://www.example.com/path', [ext()])).toBe('example.com')
  })
})
