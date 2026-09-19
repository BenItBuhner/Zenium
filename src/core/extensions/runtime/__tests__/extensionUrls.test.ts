import { describe, expect, it } from 'vitest'
import {
  chromeExtensionOrigin,
  chromeExtensionUrl,
  extensionIdOfUrl,
  isExtensionPageUrl,
  presentExtensionUrl,
  sameExtensionUrl,
  toServedUrl
} from '../extensionUrls'
import { extensionUrl } from '../plan'
import { MessageRouter, type Endpoint, type RouterOutbox } from '../router'

const ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'
const SERVED = `https://${ID}.ext.zenium.invalid`

describe('extension URL spellings', () => {
  it('maps chrome-extension:// to the served origin and back, path, query and fragment intact', () => {
    expect(toServedUrl(`chrome-extension://${ID}/options.html?tab=1#x`)).toBe(
      `${SERVED}/options.html?tab=1#x`
    )
    expect(presentExtensionUrl(`${SERVED}/options.html?tab=1#x`)).toBe(
      `chrome-extension://${ID}/options.html?tab=1#x`
    )
    // The bare origin and a query without a path get their root slash, as URL parsing gives it.
    expect(toServedUrl(`chrome-extension://${ID}`)).toBe(`${SERVED}/`)
    expect(toServedUrl(`chrome-extension://${ID}?q`)).toBe(`${SERVED}/?q`)
    expect(presentExtensionUrl(SERVED)).toBe(`chrome-extension://${ID}/`)
    expect(presentExtensionUrl(`${SERVED}#h`)).toBe(`chrome-extension://${ID}/#h`)
    // The two are inverses over what runtime.getURL answers.
    const url = extensionUrl(ID, '/a/b.js')
    expect(toServedUrl(presentExtensionUrl(url))).toBe(url)
  })

  it('leaves every other URL alone', () => {
    for (const other of [
      'https://page.example/x',
      `https://${ID}.ext.zenium.invalid.evil.example/`,
      `https://evil.example/${SERVED}/`,
      `chrome-extension://not-an-id/x`,
      `chrome-extension://${ID.slice(0, 31)}/x`,
      `chrome-extension://${ID}q/x`,
      `http://${ID}.ext.zenium.invalid/x`,
      'about:blank',
      ''
    ]) {
      expect(toServedUrl(other)).toBe(other)
      expect(presentExtensionUrl(other)).toBe(other)
      expect(isExtensionPageUrl(other)).toBe(false)
    }
  })

  it('names the extension of either spelling and compares pages across them', () => {
    expect(extensionIdOfUrl(`chrome-extension://${ID}/p`)).toBe(ID)
    expect(extensionIdOfUrl(`${SERVED}/p`)).toBe(ID)
    expect(extensionIdOfUrl(`CHROME-EXTENSION://${ID.toUpperCase()}/p`)).toBe(ID)
    expect(isExtensionPageUrl(`chrome-extension://${ID}`)).toBe(true)
    expect(
      sameExtensionUrl(`chrome-extension://${ID}/onetab.html`, extensionUrl(ID, 'onetab.html'))
    ).toBe(true)
    expect(sameExtensionUrl(`chrome-extension://${ID}/a.html`, extensionUrl(ID, 'b.html'))).toBe(
      false
    )
    expect(chromeExtensionOrigin(ID)).toBe(`chrome-extension://${ID}`)
    expect(chromeExtensionUrl(ID, '//popup.html')).toBe(`chrome-extension://${ID}/popup.html`)
  })
})

describe('sender presentation', () => {
  const outbox = (): RouterOutbox & {
    sent: Array<{ to: string; message: Record<string, unknown> }>
  } => {
    const sent: Array<{ to: string; message: Record<string, unknown> }> = []
    return {
      sent,
      send: (to, message) => void sent.push({ to, message }),
      tabFor: (tabId) => ({
        id: 1,
        url: tabId === 'tab-1' ? `chrome-extension://${ID}/options.html` : 'https://page.example/'
      }),
      tabIdFromChrome: (id) => (id === 1 ? 'tab-1' : null)
    }
  }
  const endpoint = (id: string, over: Partial<Endpoint>): Endpoint => ({
    id,
    extensionId: ID,
    context: 'content',
    tabId: 'tab-1',
    frameId: 0,
    url: 'https://page.example/',
    ...over
  })

  it("an extension page's sender passes Tampermonkey's internal-page check", () => {
    const box = outbox()
    const router = new MessageRouter(box)
    router.register(
      endpoint('bg', { context: 'background', tabId: null, url: `${SERVED}/background.js` })
    )
    router.register(
      endpoint('popup', { context: 'popup', tabId: null, url: `${SERVED}/action.html` })
    )
    router.register(
      endpoint('options', { context: 'page', url: `${SERVED}/options.html#nav=dashboard` })
    )
    router.register(endpoint('cs', { context: 'content', tabId: 'tab-2' }))

    router.handle('popup', { t: 'msg', id: 1, target: {}, data: { method: 'ping' } })
    router.handle('options', { t: 'msg', id: 2, target: {}, data: { method: 'ping' } })
    router.handle('cs', { t: 'msg', id: 3, target: {}, data: { method: 'ping' } })
    const toBg = box.sent
      .filter((s) => s.to === 'bg')
      .map((s) => s.message.sender as Record<string, unknown>)
    expect(toBg).toHaveLength(3)
    const [fromPopup, fromOptions, fromContent] = toBg

    // Tampermonkey's background (`INTERNAL_PAGE_PROTOCOLS: ["chrome-extension:"]`): the sender's
    // URL starts with `chrome-extension://`, its origin is the background's own `location.origin`,
    // and the page's name comes out of `chrome-extension://<id>/([a-zA-Z]*).html`.
    const internalPage = new RegExp(`chrome-extension://${ID}/([a-zA-Z]*)\\.html`)
    const admitted = (sender: Record<string, unknown>): string | null => {
      const url =
        (sender.url as string | undefined) ??
        (sender.tab as { url?: string } | undefined)?.url ??
        null
      const origin = (sender.origin as string | undefined)?.toLowerCase()
      const ok =
        sender.id === ID &&
        (!url || url.indexOf('chrome-extension://') === 0) &&
        (!origin || origin === SERVED.toLowerCase())
      const page = url?.match(internalPage)
      return ok && page ? page[1] : null
    }
    expect(fromPopup.url).toBe(`chrome-extension://${ID}/action.html`)
    expect(fromPopup.origin).toBe(SERVED)
    expect(admitted(fromPopup)).toBe('action')
    expect(fromOptions.url).toBe(`chrome-extension://${ID}/options.html#nav=dashboard`)
    expect((fromOptions.tab as { url: string }).url).toBe(`chrome-extension://${ID}/options.html`)
    expect(admitted(fromOptions)).toBe('options')
    // A content script keeps the page's URL and origin.
    expect(fromContent.url).toBe('https://page.example/')
    expect(fromContent.origin).toBe('https://page.example')
    expect(admitted(fromContent)).toBeNull()
  })
})
