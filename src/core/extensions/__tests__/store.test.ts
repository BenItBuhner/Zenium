import { describe, expect, it } from 'vitest'
import { sha256, toHex, utf8Encode } from '../bytes'
import {
  StoreError,
  crxDownloadUrl,
  decodeXmlEntities,
  downloadCrx,
  fetchUpdateCheck,
  isExtensionId,
  parseOmahaResponse,
  parseStorePageUrl,
  storeForEndpoint,
  updateCheckUrl,
  type StoreFetch
} from '../store'

const UBO_LITE = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const UBO_EDGE = 'odfafepnkmbhccpbejgmiehpchacaeak'
const options = { chromiumVersion: '152.0.0.0' }

// Captured verbatim from the stores on 2026-09-17.
const CWS_OK =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7198" elapsed_seconds="83235"/><app appid="ddkjiahejlhfcafbddmgiahcphecmpfh" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" codebase="https://clients2.googleusercontent.com/crx/blobs/Abe5cL5-aIOPXysaTzfChSeofB9s9jqpN3majB_vH542X7fHeLHz_De6CCPeN4ShRoV-HG-Tdq0NveYbb9tHNGOOTpdgxGv5cG0NlN_XPQIfs9pUzQKZzcAcbBsiX9439DsHAMZSmuXBSSRT2mNKZCSIWziiMhVMqA9uqQ/DDKJIAHEJLHFCAFBDDMGIAHCPHECMPFH_2026_914_1325_0.crx" fp="1.3b7845ab6cd5ed2400f7cfd6e4588d79ae9a3e00b18167e2ef4d53ad05775ed7" hash_sha256="3b7845ab6cd5ed2400f7cfd6e4588d79ae9a3e00b18167e2ef4d53ad05775ed7" protected="0" size="9674664" status="ok" version="2026.914.1325"/></app></gupdate>'
const CWS_NOUPDATE =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7198" elapsed_seconds="83420"/><app appid="ddkjiahejlhfcafbddmgiahcphecmpfh" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" status="noupdate"/></app></gupdate>'
const CWS_UNKNOWN =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7198" elapsed_seconds="83420"/><app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="error-unknownApplication"/></gupdate>'
const EDGE_OK =
  '<?xml version="1.0" encoding="utf-8"?><gupdate xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" server="prod" protocol="2.0" xmlns="http://www.google.com/update2/response"><daystart elapsed_days="2816" elapsed_seconds="22068" /><app appid="odfafepnkmbhccpbejgmiehpchacaeak" status="ok"><updatecheck status="ok" codebase="http://msedgeextensions.f.tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/e7cdcc02-4151-4a98-898a-109d2edbd7f2?P1=1790225695&amp;P2=404&amp;P3=2&amp;P4=mpSrYj%2f8y7O8yAjXziviXywkO8%2bCVvdOk7GfKoslxgjDvDoNXhNaDB3%2bp3RTeZXxX%2b2GdHRS0XPoMiGaNyiOIA%3d%3d" version="2026.916.75.0" hash_sha256="AF3124A7C4C1F18042CC7E501EF67FD7921BC2B0C6EF73BE3FB16FD8FD46704E" /></app></gupdate>'
const EDGE_NOUPDATE =
  '<?xml version="1.0" encoding="utf-8"?><gupdate xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" server="prod" protocol="2.0" xmlns="http://www.google.com/update2/response"><daystart elapsed_days="2816" elapsed_seconds="22221" /><app appid="odfafepnkmbhccpbejgmiehpchacaeak" status="ok"><updatecheck status="noupdate" /></app></gupdate>'

describe('ids and URLs', () => {
  it('validates the 32-letter a..p id format', () => {
    expect(isExtensionId(UBO_LITE)).toBe(true)
    expect(isExtensionId(UBO_LITE.toUpperCase())).toBe(false)
    expect(isExtensionId('ddkjiahejlhfcafbddmgiahcphecmpf')).toBe(false)
    expect(isExtensionId('ddkjiahejlhfcafbddmgiahcphecmpfq')).toBe(false)
  })

  it('builds the exact store download URLs', () => {
    expect(crxDownloadUrl('chrome-web-store', UBO_LITE, options)).toBe(
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=152.0.0.0&acceptformat=crx3&x=id%3D${UBO_LITE}%26uc`
    )
    expect(crxDownloadUrl('edge-add-ons', UBO_EDGE, options)).toBe(
      `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D${UBO_EDGE}%26installsource%3Dondemand%26uc`
    )
    expect(() => crxDownloadUrl('chrome-web-store', 'nope', options)).toThrow(StoreError)
  })

  it('builds update-check URLs for stores, batches and self-hosted servers', () => {
    expect(updateCheckUrl('chrome-web-store', [{ id: UBO_LITE, version: '1.0' }], options)).toBe(
      `https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=152.0.0.0&acceptformat=crx3&x=id%3D${UBO_LITE}%26v%3D1.0%26uc`
    )
    expect(
      updateCheckUrl(
        'https://edge.microsoft.com/extensionwebstorebase/v1/crx',
        [{ id: UBO_EDGE, version: '2.0' }],
        options
      )
    ).toBe(
      `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=updatecheck&prodversion=152.0.0.0&acceptformat=crx3&x=id%3D${UBO_EDGE}%26v%3D2.0%26installsource%3Dondemand%26uc`
    )
    const batch = updateCheckUrl(
      'chrome-web-store',
      [
        { id: UBO_LITE, version: '1' },
        { id: UBO_EDGE, version: '2' }
      ],
      options
    )
    expect(batch.match(/&x=/g)).toHaveLength(2)
    expect(
      updateCheckUrl(
        'https://example.com/updates.xml?channel=stable',
        [{ id: UBO_LITE, version: '3' }],
        options
      )
    ).toBe(
      `https://example.com/updates.xml?channel=stable&response=updatecheck&prodversion=152.0.0.0&acceptformat=crx3&x=id%3D${UBO_LITE}%26v%3D3%26uc`
    )
    expect(() => updateCheckUrl('chrome-web-store', [], options)).toThrow(StoreError)
    expect(() => updateCheckUrl('not a url', [{ id: UBO_LITE, version: '1' }], options)).toThrow(
      /Invalid update URL/
    )
    expect(() => updateCheckUrl('ftp://x/y', [{ id: UBO_LITE, version: '1' }], options)).toThrow(
      /http/
    )
  })

  it('maps update_url values to stores', () => {
    expect(storeForEndpoint('https://clients2.google.com/service/update2/crx')).toBe(
      'chrome-web-store'
    )
    expect(storeForEndpoint('https://edge.microsoft.com/extensionwebstorebase/v1/crx')).toBe(
      'edge-add-ons'
    )
    expect(storeForEndpoint('https://example.com/update.xml')).toBeNull()
    expect(storeForEndpoint('garbage')).toBeNull()
    expect(storeForEndpoint('edge-add-ons')).toBe('edge-add-ons')
  })

  it('parses store listing URLs', () => {
    expect(
      parseStorePageUrl(`https://chromewebstore.google.com/detail/ublock-origin-lite/${UBO_LITE}`)
    ).toEqual({
      store: 'chrome-web-store',
      id: UBO_LITE,
      slug: 'ublock-origin-lite'
    })
    expect(parseStorePageUrl(`https://chromewebstore.google.com/detail/${UBO_LITE}?hl=en`)).toEqual(
      {
        store: 'chrome-web-store',
        id: UBO_LITE,
        slug: null
      }
    )
    expect(
      parseStorePageUrl(
        `https://chrome.google.com/webstore/detail/ublock-origin/${UBO_LITE}/related`
      )
    ).toEqual({
      store: 'chrome-web-store',
      id: UBO_LITE,
      slug: 'ublock-origin'
    })
    expect(
      parseStorePageUrl(
        `https://microsoftedge.microsoft.com/addons/detail/ublock-origin/${UBO_EDGE}`
      )
    ).toEqual({
      store: 'edge-add-ons',
      id: UBO_EDGE,
      slug: 'ublock-origin'
    })
    expect(parseStorePageUrl('https://chromewebstore.google.com/category/extensions')).toBeNull()
    expect(parseStorePageUrl('https://example.com/detail/x/' + UBO_LITE)).toBeNull()
    expect(parseStorePageUrl('javascript:alert(1)')).toBeNull()
    expect(parseStorePageUrl('not a url')).toBeNull()
  })
})

describe('Omaha responses', () => {
  it('decodes XML entities', () => {
    expect(decodeXmlEntities('a&amp;b&lt;c&gt;&quot;&apos;&#65;&#x42;&unknown;')).toBe(
      'a&b<c>"\'AB&unknown;'
    )
  })

  it('parses a Chrome Web Store update', () => {
    const [app] = parseOmahaResponse(CWS_OK)
    expect(app.appId).toBe(UBO_LITE)
    expect(app.status).toBe('ok')
    expect(app.update?.version).toBe('2026.914.1325')
    expect(app.update?.codebase).toMatch(
      /^https:\/\/clients2\.googleusercontent\.com\/crx\/blobs\/.*\.crx$/
    )
    expect(app.update?.sha256).toBe(
      '3b7845ab6cd5ed2400f7cfd6e4588d79ae9a3e00b18167e2ef4d53ad05775ed7'
    )
    expect(app.update?.size).toBe(9674664)
  })

  it('parses noupdate and unknown-application answers from both stores', () => {
    expect(parseOmahaResponse(CWS_NOUPDATE)).toEqual([
      { appId: UBO_LITE, status: 'noupdate', update: null }
    ])
    expect(parseOmahaResponse(EDGE_NOUPDATE)).toEqual([
      { appId: UBO_EDGE, status: 'noupdate', update: null }
    ])
    expect(parseOmahaResponse(CWS_UNKNOWN)).toEqual([
      {
        appId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'error-unknownApplication',
        update: null
      }
    ])
  })

  it('parses an Edge update, decoding &amp; in the CDN URL and lowercasing the hash', () => {
    const [app] = parseOmahaResponse(EDGE_OK)
    expect(app.status).toBe('ok')
    expect(app.update?.version).toBe('2026.916.75.0')
    expect(app.update?.codebase).toBe(
      'http://msedgeextensions.f.tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/e7cdcc02-4151-4a98-898a-109d2edbd7f2?P1=1790225695&P2=404&P3=2&P4=mpSrYj%2f8y7O8yAjXziviXywkO8%2bCVvdOk7GfKoslxgjDvDoNXhNaDB3%2bp3RTeZXxX%2b2GdHRS0XPoMiGaNyiOIA%3d%3d'
    )
    expect(app.update?.sha256).toBe(
      'af3124a7c4c1f18042cc7e501ef67fd7921bc2b0c6ef73be3fb16fd8fd46704e'
    )
    expect(app.update?.size).toBeNull()
  })

  it('handles multi-app responses and malformed documents', () => {
    const multi = `<gupdate protocol="2.0"><app appid="${UBO_LITE}" status="ok"><updatecheck status="ok" version="2" codebase="https://x/a.crx"/></app><app appid="${UBO_EDGE}" status="ok"><updatecheck status="ok" version="3"/></app><app appid="x" status="ok"></app></gupdate>`
    const apps = parseOmahaResponse(multi)
    expect(apps.map((a) => a.status)).toEqual([
      'ok',
      'error-incompleteUpdatecheck',
      'error-missingUpdatecheck'
    ])
    expect(() => parseOmahaResponse('<html>Not found</html>')).toThrow(StoreError)
    expect(parseOmahaResponse('<gupdate protocol="2.0"></gupdate>')).toEqual([])
  })
})

describe('network operations over the injected fetch', () => {
  const fakeFetch =
    (status: number, body: Uint8Array): StoreFetch =>
    async (url) => ({ status, url, bytes: body })

  it('runs an update check through the host fetch', async () => {
    const apps = await fetchUpdateCheck(fakeFetch(200, utf8Encode(CWS_OK)), 'https://example.test/')
    expect(apps[0].update?.version).toBe('2026.914.1325')
    await expect(
      fetchUpdateCheck(fakeFetch(503, new Uint8Array()), 'https://example.test/')
    ).rejects.toThrow(/HTTP 503/)
  })

  it('downloads a CRX and verifies the announced hash', async () => {
    const body = utf8Encode('pretend this is a crx')
    const hash = toHex(await sha256(body))
    expect(
      await downloadCrx(fakeFetch(200, body), 'https://cdn.test/x.crx', {
        sha256: hash.toUpperCase()
      })
    ).toBe(body)
    expect(await downloadCrx(fakeFetch(200, body), 'https://cdn.test/x.crx')).toBe(body)
    await expect(
      downloadCrx(fakeFetch(200, body), 'https://cdn.test/x.crx', { sha256: '00'.repeat(32) })
    ).rejects.toThrow(/hash/)
    await expect(downloadCrx(fakeFetch(404, body), 'https://cdn.test/x.crx')).rejects.toThrow(
      /HTTP 404/
    )
  })
})
