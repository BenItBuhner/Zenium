import { describe, expect, it } from 'vitest'
import { newRecord, type ExtensionRecord } from '../registry'
import {
  CHROME_BRAND,
  DEFAULT_WEBSTORE_PREFERENCES,
  EDGE_BRAND,
  SIGNED_OUT_BROWSER_LOGIN,
  STORE_BRANDS,
  WEBSTORE_PRIVATE_MEMBERS,
  WEBSTORE_PRIVATE_OPTIONAL_MEMBERS,
  installStatusFor,
  isWebstorePage,
  managementInfoFor,
  parseBeginInstallDetails,
  storeForFrame,
  storeForPage,
  withBrand,
  withChromeBrand,
  withChromeClientHints,
  withClientHintBrand,
  withEdgeIdentity,
  withEdgeToken
} from '../webstorePrivate'

const ID = 'bcjindcccaagfpapjjmafapmmgkkhgoa'
const EDGE_ID = 'odfafepnkmbhccpbejgmiehpchacaeak'
const EDGE_PAGE = `https://microsoftedge.microsoft.com/addons/detail/ublock-origin/${EDGE_ID}`
const CHROMIUM_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const record = (overrides: Partial<ExtensionRecord> = {}): ExtensionRecord => ({
  ...newRecord({
    id: ID,
    source: 'chrome-web-store',
    path: `/data/extensions/${ID}/0.7.2`,
    manifest: {
      manifest_version: 3,
      name: 'JSON Formatter',
      version: '0.7.2',
      description: 'Makes JSON easy to read.',
      permissions: ['storage'],
      host_permissions: ['<all_urls>'],
      options_ui: { page: 'options.html' }
    },
    now: 1_800_000_000_000,
    publisher: 'chrome-web-store',
    updateUrl: 'https://clients2.google.com/service/update2/crx'
  }),
  ...overrides
})

describe('storeForPage / isWebstorePage', () => {
  it('accepts both Chrome Web Store hosts, the legacy one only on its webstore path', () => {
    expect(storeForPage(`https://chromewebstore.google.com/detail/json-formatter/${ID}`)).toBe(
      'chrome-web-store'
    )
    expect(isWebstorePage('https://chromewebstore.google.com/')).toBe(true)
    expect(storeForPage(`https://chrome.google.com/webstore/detail/${ID}`)).toBe('chrome-web-store')
    expect(isWebstorePage('https://chrome.google.com/webstore')).toBe(true)
    expect(storeForPage('https://chrome.google.com/')).toBeNull()
    expect(isWebstorePage('https://chrome.google.com/intl/en/chrome/')).toBe(false)
  })

  it('accepts the Edge Add-ons host over https', () => {
    expect(storeForPage(EDGE_PAGE)).toBe('edge-add-ons')
    expect(storeForPage('https://microsoftedge.microsoft.com/addons/')).toBe('edge-add-ons')
    expect(storeForPage('https://microsoftedge.microsoft.com/')).toBe('edge-add-ons')
    expect(isWebstorePage('https://microsoftedge.microsoft.com/addons/search/dark%20reader')).toBe(
      true
    )
    expect(storeForPage(`http://microsoftedge.microsoft.com/addons/detail/${EDGE_ID}`)).toBeNull()
    expect(storeForPage('https://www.microsoft.com/en-us/edge')).toBeNull()
    expect(storeForPage('https://microsoftedge.microsoft.com.evil.example/addons/')).toBeNull()
    expect(storeForPage('https://edge.microsoft.com/extensionwebstorebase/v1/crx')).toBeNull()
  })

  it('rejects other origins, other schemes and junk', () => {
    expect(isWebstorePage(`http://chromewebstore.google.com/detail/${ID}`)).toBe(false)
    expect(isWebstorePage('https://chromewebstore.google.com.evil.example/')).toBe(false)
    expect(isWebstorePage('https://evil.example/chromewebstore.google.com/')).toBe(false)
    expect(isWebstorePage('https://evil.example/microsoftedge.microsoft.com/addons/')).toBe(false)
    expect(isWebstorePage('about:blank')).toBe(false)
    expect(isWebstorePage('not a url')).toBe(false)
    expect(isWebstorePage('')).toBe(false)
  })
})

describe('storeForFrame', () => {
  it('is the frame page store, and the parent store for a blank child frame', () => {
    expect(storeForFrame(EDGE_PAGE, null)).toBe('edge-add-ons')
    expect(storeForFrame(`https://chromewebstore.google.com/detail/${ID}`, null)).toBe(
      'chrome-web-store'
    )
    expect(storeForFrame('about:blank', EDGE_PAGE)).toBe('edge-add-ons')
    expect(storeForFrame('about:blank', `https://chrome.google.com/webstore/detail/${ID}`)).toBe(
      'chrome-web-store'
    )
  })

  it('gives nothing to blank frames without a store parent and to other pages under a store', () => {
    expect(storeForFrame('about:blank', null)).toBeNull()
    expect(storeForFrame('about:blank', 'https://example.com/')).toBeNull()
    expect(storeForFrame('about:blank', 'about:blank')).toBeNull()
    expect(storeForFrame('https://example.com/', EDGE_PAGE)).toBeNull()
    expect(storeForFrame('about:srcdoc', EDGE_PAGE)).toBeNull()
  })
})

describe('the member lists', () => {
  it("answer Edge's members and leave its probed-only member undefined", () => {
    expect(WEBSTORE_PRIVATE_MEMBERS).toContain('completeInstallWithCV')
    expect(WEBSTORE_PRIVATE_MEMBERS).toContain('getPreferences')
    expect(WEBSTORE_PRIVATE_MEMBERS).toContain('getBrowserLogin')
    expect(WEBSTORE_PRIVATE_OPTIONAL_MEMBERS).toEqual(['showFeedbackDialog'])
    for (const name of WEBSTORE_PRIVATE_OPTIONAL_MEMBERS)
      expect(WEBSTORE_PRIVATE_MEMBERS as readonly string[]).not.toContain(name)
    expect(new Set(WEBSTORE_PRIVATE_MEMBERS).size).toBe(WEBSTORE_PRIVATE_MEMBERS.length)
  })

  it('shape the Edge results the page destructures', () => {
    expect(SIGNED_OUT_BROWSER_LOGIN).toEqual({
      login: '',
      account_type: '',
      account_location: '',
      age_group_type: 'Undefined'
    })
    expect(DEFAULT_WEBSTORE_PREFERENCES).toEqual({
      is_edge_feedback_enabled: true,
      aadc_age_group: 'NotApplicable'
    })
    expect(STORE_BRANDS).toEqual({
      'chrome-web-store': 'Google Chrome',
      'edge-add-ons': 'Microsoft Edge'
    })
  })
})

describe('parseBeginInstallDetails', () => {
  it('parses what the store page sends', () => {
    expect(
      parseBeginInstallDetails({
        id: ID,
        manifest: '{"name":"JSON Formatter","version":"0.7.2"}',
        localizedName: 'JSON Formatter',
        iconUrl: 'https://lh3.googleusercontent.com/icon',
        esbAllowlist: true
      })
    ).toEqual({
      id: ID,
      manifest: { name: 'JSON Formatter', version: '0.7.2' },
      localizedName: 'JSON Formatter',
      iconUrl: 'https://lh3.googleusercontent.com/icon'
    })
  })

  it('needs a well-formed id and treats everything else as optional', () => {
    expect(parseBeginInstallDetails(undefined)).toBeNull()
    expect(parseBeginInstallDetails('x')).toBeNull()
    expect(parseBeginInstallDetails({})).toBeNull()
    expect(parseBeginInstallDetails({ id: 'short' })).toBeNull()
    expect(parseBeginInstallDetails({ id: ID.toUpperCase() })).toBeNull()
    expect(parseBeginInstallDetails({ id: ID })).toEqual({
      id: ID,
      manifest: null,
      localizedName: null,
      iconUrl: null
    })
  })

  it('drops a manifest that is not a JSON object', () => {
    expect(parseBeginInstallDetails({ id: ID, manifest: '{not json' })?.manifest).toBeNull()
    expect(parseBeginInstallDetails({ id: ID, manifest: '[1,2]' })?.manifest).toBeNull()
    expect(parseBeginInstallDetails({ id: ID, manifest: '"str"' })?.manifest).toBeNull()
    expect(parseBeginInstallDetails({ id: ID, manifest: { name: 'x' } })?.manifest).toBeNull()
  })
})

describe('installStatusFor', () => {
  it('maps a registry lookup to the ExtensionInstallStatus the page expects', () => {
    expect(installStatusFor(null)).toBe('installable')
    expect(installStatusFor(undefined)).toBe('installable')
    expect(installStatusFor({ enabled: true })).toBe('enabled')
    expect(installStatusFor({ enabled: false })).toBe('disabled')
  })
})

describe('managementInfoFor', () => {
  it('fills chrome.management.ExtensionInfo from a record', () => {
    expect(managementInfoFor(record())).toEqual({
      id: ID,
      name: 'JSON Formatter',
      shortName: 'JSON Formatter',
      description: 'Makes JSON easy to read.',
      version: '0.7.2',
      mayDisable: true,
      mayEnable: true,
      enabled: true,
      isApp: false,
      type: 'extension',
      offlineEnabled: false,
      optionsUrl: `chrome-extension://${ID}/options.html`,
      permissions: ['storage'],
      hostPermissions: ['<all_urls>'],
      installType: 'normal',
      updateUrl: 'https://clients2.google.com/service/update2/crx'
    })
  })

  it('maps the install source to Chrome install types', () => {
    expect(managementInfoFor(record({ source: 'edge-add-ons' })).installType).toBe('normal')
    expect(managementInfoFor(record({ source: 'crx' })).installType).toBe('sideload')
    expect(managementInfoFor(record({ source: 'zip' })).installType).toBe('sideload')
    expect(managementInfoFor(record({ source: 'unpacked' })).installType).toBe('development')
  })

  it('explains why a disabled extension is disabled and leaves optional fields out', () => {
    const disabled = managementInfoFor(
      record({ enabled: false, optionsPage: null, updateUrl: null })
    )
    expect(disabled.enabled).toBe(false)
    expect(disabled.disabledReason).toBe('unknown')
    expect(disabled.optionsUrl).toBe('')
    expect(disabled).not.toHaveProperty('updateUrl')
    expect(disabled).not.toHaveProperty('icons')
    const pending = managementInfoFor(
      record({ enabled: false, pendingWarnings: ['Read your browsing history'] })
    )
    expect(pending.disabledReason).toBe('permissions_increase')
    expect(managementInfoFor(record())).not.toHaveProperty('disabledReason')
  })

  it('attaches icons when the host resolved some', () => {
    const icons = [{ size: 128, url: 'data:image/png;base64,AAAA' }]
    expect(managementInfoFor(record(), icons).icons).toEqual(icons)
  })
})

describe('withChromeBrand', () => {
  it('inserts Google Chrome after Chromium with the same version', () => {
    expect(withChromeBrand('"Chromium";v="152", "Not_A Brand";v="24"', '999')).toBe(
      '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"'
    )
    expect(
      withChromeBrand('"Not)A;Brand";v="8.0.0.0", "Chromium";v="152.0.7359.98"', '1.2.3.4')
    ).toBe(
      '"Not)A;Brand";v="8.0.0.0", "Chromium";v="152.0.7359.98", "Google Chrome";v="152.0.7359.98"'
    )
  })

  it('leaves a list that already names Chrome alone', () => {
    const chrome = '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"'
    expect(withChromeBrand(chrome, '1')).toBe(chrome)
  })

  it('appends with the given version when there is no Chromium entry', () => {
    expect(withChromeBrand('"Not_A Brand";v="24"', '152')).toBe(
      `"Not_A Brand";v="24", "${CHROME_BRAND}";v="152"`
    )
    expect(withChromeBrand('', '152')).toBe(`"${CHROME_BRAND}";v="152"`)
  })
})

describe('withChromeClientHints', () => {
  it('rewrites the brand lists in place, keeping header casing and other headers', () => {
    const headers = {
      Accept: 'text/html',
      'Sec-CH-UA': '"Chromium";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
      'User-Agent': 'Mozilla/5.0 Chrome/152.0.0.0'
    }
    expect(withChromeClientHints(headers, '152.0.7359.98')).toEqual({
      Accept: 'text/html',
      'Sec-CH-UA': '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List':
        '"Chromium";v="152.0.7359.98", "Google Chrome";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
      'User-Agent': 'Mozilla/5.0 Chrome/152.0.0.0'
    })
    expect(headers['Sec-CH-UA']).toBe('"Chromium";v="152", "Not_A Brand";v="24"')
  })

  it('adds a Chrome-shaped sec-ch-ua when the request carried none', () => {
    expect(withChromeClientHints({ Accept: '*/*' }, '152.0.7359.98')).toEqual({
      Accept: '*/*',
      'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"'
    })
  })

  it('is idempotent', () => {
    const once = withChromeClientHints({ 'sec-ch-ua': '"Chromium";v="152"' }, '152.0.0.0')
    expect(withChromeClientHints(once, '152.0.0.0')).toEqual(once)
  })
})

describe('withBrand / withClientHintBrand for Edge', () => {
  it('inserts Microsoft Edge after Chromium with the same version, once', () => {
    const edge = withBrand('"Chromium";v="152", "Not_A Brand";v="24"', EDGE_BRAND, '999')
    expect(edge).toBe('"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"')
    expect(withBrand(edge, EDGE_BRAND, '1')).toBe(edge)
    expect(withBrand('', EDGE_BRAND, '152')).toBe('"Microsoft Edge";v="152"')
  })

  it('does not put Chrome next to Edge or Edge next to Chrome', () => {
    const chrome = withChromeBrand('"Chromium";v="152"', '152')
    expect(chrome).not.toContain(EDGE_BRAND)
    const edge = withBrand('"Chromium";v="152"', EDGE_BRAND, '152')
    expect(edge).not.toContain(CHROME_BRAND)
  })

  it('rewrites both hint headers with Edge, keeping casing and other headers', () => {
    const headers = {
      'Sec-CH-UA': '"Chromium";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
      Accept: 'text/html'
    }
    expect(withClientHintBrand(headers, EDGE_BRAND, '152.0.7359.98')).toEqual({
      'Sec-CH-UA': '"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List':
        '"Chromium";v="152.0.7359.98", "Microsoft Edge";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
      Accept: 'text/html'
    })
  })
})

describe('withEdgeToken', () => {
  it("appends Edge's reduced token with the Chromium major", () => {
    expect(withEdgeToken(CHROMIUM_UA, '152.0.7359.98')).toBe(`${CHROMIUM_UA} Edg/152.0.0.0`)
    expect(withEdgeToken('Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36', '153')).toBe(
      'Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0'
    )
  })

  it('leaves a string that already names Edge alone', () => {
    const edge = `${CHROMIUM_UA} Edg/152.0.0.0`
    expect(withEdgeToken(edge, '152.0.7359.98')).toBe(edge)
    const real = `${CHROMIUM_UA} Edg/152.0.3485.54`
    expect(withEdgeToken(real, '152.0.7359.98')).toBe(real)
    expect(withEdgeToken('Mozilla/5.0 EdgA/152.0.0.0', '152')).toBe(
      'Mozilla/5.0 EdgA/152.0.0.0 Edg/152.0.0.0'
    )
  })
})

describe('withEdgeIdentity', () => {
  const request = {
    'User-Agent': CHROMIUM_UA,
    'Sec-CH-UA': '"Chromium";v="152", "Not_A Brand";v="24"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
    'Sec-CH-UA-Mobile': '?0',
    Accept: 'text/html',
    Cookie: 'x=1'
  }

  it('makes the request look like Edge: UA token plus brand, other headers untouched', () => {
    const result = withEdgeIdentity(request, '152.0.7359.98')
    expect(result).toEqual({
      ...request,
      'User-Agent': `${CHROMIUM_UA} Edg/152.0.0.0`,
      'Sec-CH-UA': '"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List':
        '"Chromium";v="152.0.7359.98", "Microsoft Edge";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"'
    })
    expect(result).not.toBe(request)
    expect(request['User-Agent']).toBe(CHROMIUM_UA)
  })

  it('is idempotent and case-insensitive on the header name', () => {
    const once = withEdgeIdentity(request, '152.0.7359.98')
    expect(withEdgeIdentity(once, '152.0.7359.98')).toEqual(once)
    expect(withEdgeIdentity({ 'user-agent': CHROMIUM_UA }, '152.0.7359.98')).toEqual({
      'user-agent': `${CHROMIUM_UA} Edg/152.0.0.0`,
      'sec-ch-ua': '"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"'
    })
  })

  it('does not invent a User-Agent for a request that carries none', () => {
    expect(withEdgeIdentity({ Accept: '*/*' }, '152.0.7359.98')).toEqual({
      Accept: '*/*',
      'sec-ch-ua': '"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"'
    })
  })
})
