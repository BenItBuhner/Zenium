import { describe, expect, it } from 'vitest'
import { isDynamicExtensionHost, ownResourcePath } from '../ownResource'

const EXT = 'pbanhockgagggenencehbnadejlgchfc'
const OTHER = 'mmeijimgabbpbgpdklnllpncmdofkcpn'
/** The per-session origin Chromium's `runtime.getURL` answers for a `use_dynamic_url` path. */
const GUID = 'e4ef1c37-3daf-421b-aa31-86ab8bbd94d0'

describe('ownResourcePath: the spellings an extension names its own file by', () => {
  it('reads a package path with or without a leading slash, query and fragment dropped', () => {
    expect(ownResourcePath(EXT, 'assets/icons/favicon-16.png')).toBe('assets/icons/favicon-16.png')
    expect(ownResourcePath(EXT, '/assets/icons/favicon-16.png')).toBe('assets/icons/favicon-16.png')
    expect(ownResourcePath(EXT, 'icons/a.png?v=2#x')).toBe('icons/a.png')
  })

  it('reads the static URL and the dynamic GUID URL alike, percent-escapes decoded', () => {
    expect(ownResourcePath(EXT, `chrome-extension://${EXT}/assets/icons/favicon-16.png`)).toBe(
      'assets/icons/favicon-16.png'
    )
    expect(ownResourcePath(EXT, `chrome-extension://${GUID}/assets/icons/favicon-16.png`)).toBe(
      'assets/icons/favicon-16.png'
    )
    expect(ownResourcePath(EXT, `chrome-extension://${GUID.toUpperCase()}/a%20b/c.png`)).toBe(
      'a b/c.png'
    )
  })

  it("refuses another extension's static origin, other schemes and text no URL parser takes", () => {
    expect(ownResourcePath(EXT, `chrome-extension://${OTHER}/icons/a.png`)).toBeNull()
    expect(ownResourcePath(EXT, 'chrome-extension://not-a-guid-nor-an-id/icons/a.png')).toBeNull()
    expect(ownResourcePath(EXT, 'https://example.com/icons/a.png')).toBeNull()
    expect(ownResourcePath(EXT, 'data:image/png;base64,AAAA')).toBeNull()
    expect(ownResourcePath(EXT, 'chrome-extension://')).toBeNull()
  })

  it('knows the dynamic host by its shape, a version-4 UUID', () => {
    expect(isDynamicExtensionHost(GUID)).toBe(true)
    expect(isDynamicExtensionHost(EXT)).toBe(false)
    expect(isDynamicExtensionHost('e4ef1c37-3daf-421b-aa31')).toBe(false)
  })
})
