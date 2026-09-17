import { describe, expect, it } from 'vitest'
import { newRecord, type ExtensionRecord } from '../registry'
import {
  CHROME_BRAND,
  installStatusFor,
  isWebstorePage,
  managementInfoFor,
  parseBeginInstallDetails,
  withChromeBrand,
  withChromeClientHints
} from '../webstorePrivate'

const ID = 'bcjindcccaagfpapjjmafapmmgkkhgoa'

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

describe('isWebstorePage', () => {
  it('accepts both store hosts, the legacy one only on its webstore path', () => {
    expect(isWebstorePage(`https://chromewebstore.google.com/detail/json-formatter/${ID}`)).toBe(
      true
    )
    expect(isWebstorePage('https://chromewebstore.google.com/')).toBe(true)
    expect(isWebstorePage(`https://chrome.google.com/webstore/detail/${ID}`)).toBe(true)
    expect(isWebstorePage('https://chrome.google.com/webstore')).toBe(true)
    expect(isWebstorePage('https://chrome.google.com/')).toBe(false)
    expect(isWebstorePage('https://chrome.google.com/intl/en/chrome/')).toBe(false)
  })

  it('rejects other origins, other schemes and junk', () => {
    expect(isWebstorePage(`http://chromewebstore.google.com/detail/${ID}`)).toBe(false)
    expect(isWebstorePage('https://chromewebstore.google.com.evil.example/')).toBe(false)
    expect(isWebstorePage('https://evil.example/chromewebstore.google.com/')).toBe(false)
    expect(isWebstorePage('https://microsoftedge.microsoft.com/addons/')).toBe(false)
    expect(isWebstorePage('about:blank')).toBe(false)
    expect(isWebstorePage('not a url')).toBe(false)
    expect(isWebstorePage('')).toBe(false)
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
