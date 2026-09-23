import { describe, expect, it } from 'vitest'
import {
  MessageRouter,
  NO_RECEIVER,
  PORT_CLOSED,
  type Endpoint,
  type RouterOutbox
} from '../router'

const EXT = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'

function setup(): {
  router: MessageRouter
  sent: Array<{ to: string; message: Record<string, unknown> }>
  take: (to: string) => Record<string, unknown>[]
} {
  const sent: Array<{ to: string; message: Record<string, unknown> }> = []
  const outbox: RouterOutbox = {
    send: (to, message) => void sent.push({ to, message }),
    tabFor: (tabId) => ({ id: tabId === 'tab-1' ? 1 : 2, url: 'https://page.example/' }),
    tabIdFromChrome: (id) => (id === 1 ? 'tab-1' : id === 2 ? 'tab-2' : null)
  }
  const router = new MessageRouter(outbox)
  const take = (to: string): Record<string, unknown>[] => {
    const mine = sent.filter((s) => s.to === to).map((s) => s.message)
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].to === to) sent.splice(i, 1)
    return mine
  }
  return { router, sent, take }
}

const endpoint = (id: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  extensionId: EXT,
  context: 'content',
  tabId: 'tab-1',
  frameId: 0,
  url: 'https://page.example/',
  ...over
})

describe('runtime.sendMessage', () => {
  it('delivers to the extension pages (not the sender), first response wins', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(
      endpoint('bg', {
        context: 'background',
        tabId: null,
        url: `https://${EXT}.ext.zenium.invalid/_generated_background_page.html`
      })
    )
    router.register(
      endpoint('popup', {
        context: 'popup',
        tabId: null,
        url: `https://${EXT}.ext.zenium.invalid/popup.html`
      })
    )

    router.handle('cs', {
      t: 'msg',
      id: 7,
      target: { extensionId: null, options: null },
      data: { type: 'ping' }
    })
    const toBg = take('bg')
    const toPopup = take('popup')
    expect(toBg).toHaveLength(1)
    expect(toPopup).toHaveLength(1)
    expect(toBg[0]).toMatchObject({ t: 'deliver', data: { type: 'ping' } })
    const sender = toBg[0].sender as Record<string, unknown>
    expect(sender).toMatchObject({
      id: EXT,
      url: 'https://page.example/',
      frameId: 0,
      origin: 'https://page.example'
    })
    expect(sender.tab).toEqual({ id: 1, url: 'https://page.example/' })
    expect(take('cs')).toEqual([])

    const rid = toBg[0].id
    router.handle('popup', { t: 'msgReply', id: rid, handled: false, listeners: false })
    expect(take('cs')).toEqual([])
    router.handle('bg', { t: 'msgReply', id: rid, handled: true, response: { pong: true } })
    expect(take('cs')).toEqual([{ t: 'reply', id: 7, ok: true, result: { pong: true } }])
  })

  it('errors when nobody listens and resolves undefined when listeners stay silent', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.handle('cs', { t: 'msg', id: 1, target: { extensionId: null }, data: 1 })
    expect(take('cs')).toEqual([{ t: 'reply', id: 1, ok: false, error: NO_RECEIVER }])

    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.handle('cs', { t: 'msg', id: 2, target: { extensionId: null }, data: 1 })
    const [deliver] = take('bg')
    router.handle('bg', { t: 'msgReply', id: deliver.id, handled: false, listeners: false })
    expect(take('cs')).toEqual([{ t: 'reply', id: 2, ok: false, error: NO_RECEIVER }])

    router.handle('cs', { t: 'msg', id: 3, target: { extensionId: null }, data: 1 })
    const [deliver2] = take('bg')
    router.handle('bg', { t: 'msgReply', id: deliver2.id, handled: false, listeners: true })
    expect(take('cs')).toEqual([{ t: 'reply', id: 3, ok: true, result: null }])
  })

  it('reports a port the listeners let close to a sender that passed a callback', () => {
    // Chrome's OneTimeMessageHandler::DisconnectOpener: the callback form takes a closed port
    // as "The message port closed before a response was received." (it asked for a response),
    // the promise form as delivery; "nobody listens" stays the receiving-end error for both.
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(endpoint('bg', { context: 'background', tabId: null }))

    router.handle('cs', { t: 'msg', id: 1, target: { extensionId: null }, data: 1, callback: true })
    const [deliver] = take('bg')
    router.handle('bg', { t: 'msgReply', id: deliver.id, handled: false, listeners: true })
    expect(take('cs')).toEqual([{ t: 'reply', id: 1, ok: false, error: PORT_CLOSED }])

    router.handle('cs', { t: 'msg', id: 2, target: { extensionId: null }, data: 1, callback: true })
    const [deliver2] = take('bg')
    router.handle('bg', { t: 'msgReply', id: deliver2.id, handled: true, willRespond: true })
    router.unregister('bg')
    expect(take('cs')).toEqual([{ t: 'reply', id: 2, ok: false, error: PORT_CLOSED }])

    router.handle('cs', { t: 'msg', id: 3, target: { extensionId: null }, data: 1, callback: true })
    expect(take('cs')).toEqual([{ t: 'reply', id: 3, ok: false, error: NO_RECEIVER }])
  })

  it('waits for an asynchronous sendResponse', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.handle('cs', { t: 'msg', id: 4, target: { extensionId: null }, data: 1 })
    const [deliver] = take('bg')
    router.handle('bg', { t: 'msgReply', id: deliver.id, handled: true, willRespond: true })
    expect(take('cs')).toEqual([])
    router.handle('bg', { t: 'msgReply', id: deliver.id, handled: true, response: 'later' })
    expect(take('cs')).toEqual([{ t: 'reply', id: 4, ok: true, result: 'later' }])
  })

  it('fails a pending async response when the responder goes away', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.handle('cs', { t: 'msg', id: 5, target: { extensionId: null }, data: 1 })
    const [deliver] = take('bg')
    router.handle('bg', { t: 'msgReply', id: deliver.id, handled: true, willRespond: true })
    router.unregister('bg')
    expect(take('cs')).toEqual([{ t: 'reply', id: 5, ok: true, result: null }])
  })

  it('refuses cross-extension messages', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.handle('cs', { t: 'msg', id: 6, target: { extensionId: 'a'.repeat(32) }, data: 1 })
    expect(take('cs')).toEqual([{ t: 'reply', id: 6, ok: false, error: NO_RECEIVER }])
    expect(take('bg')).toEqual([])
  })
})

describe('tabs.sendMessage', () => {
  it('targets the frames of one tab, optionally one frame', () => {
    const { router, take } = setup()
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.register(endpoint('top', { frameId: 0 }))
    router.register(endpoint('sub', { frameId: 5, url: 'https://ads.example/' }))
    router.register(endpoint('other', { tabId: 'tab-2' }))

    router.handle('bg', { t: 'msg', id: 1, target: { tabId: 1, options: null }, data: 'hi' })
    expect(take('top')).toHaveLength(1)
    expect(take('sub')).toHaveLength(1)
    expect(take('other')).toEqual([])

    router.handle('bg', {
      t: 'msg',
      id: 2,
      target: { tabId: 1, options: { frameId: 5 } },
      data: 'hi'
    })
    expect(take('top')).toEqual([])
    const [deliver] = take('sub')
    expect(deliver).toMatchObject({ t: 'deliver', data: 'hi' })
    expect((deliver.sender as Record<string, unknown>).tab).toBeUndefined()

    router.handle('bg', { t: 'msg', id: 3, target: { tabId: 9 }, data: 'hi' })
    expect(take('bg').at(-1)).toEqual({ t: 'reply', id: 3, ok: false, error: 'No tab with id: 9.' })
  })

  it("reaches the tab's user-script worlds too, never the extension's own pages", () => {
    const { router, take } = setup()
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.register(endpoint('popup', { context: 'popup', tabId: null }))
    router.register(endpoint('top', { frameId: 0 }))
    // Tampermonkey's content.js: a `runtime.onMessage` listener in the USER_SCRIPT world.
    router.register(endpoint('world', { context: 'userScript', frameId: 0 }))

    router.handle('bg', { t: 'msg', id: 1, target: { tabId: 1, options: null }, data: 'hi' })
    expect(take('top')).toHaveLength(1)
    const [deliver] = take('world')
    expect(deliver).toMatchObject({ t: 'deliver', data: 'hi' })
    // Sent by the background: not a user script's message, so the world's onMessage hears it.
    expect(deliver.userScript).toBeUndefined()
    expect(take('popup')).toEqual([])

    // A runtime.sendMessage from the world lands on the pages alone, flagged as a user script's.
    router.handle('world', { t: 'msg', id: 1, target: {}, data: 'up', userScript: true })
    expect(take('bg').at(-1)).toMatchObject({ t: 'deliver', data: 'up', userScript: true })
    expect(take('popup').at(-1)).toMatchObject({ t: 'deliver', data: 'up', userScript: true })
    expect(take('top')).toEqual([])
  })

  it("an extension page open as a tab is the tab's sender and hears the tab's messages; a popup is neither", () => {
    const { router, take } = setup()
    const pageUrl = `https://${EXT}.ext.zenium.invalid/pages/options.html`
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.register(endpoint('popup', { context: 'popup', tabId: null }))
    // Vimium's options page in a tab: its own frontend script asks the background
    // `initializeFrame`, which answers nothing to a sender without a tab.
    router.register(endpoint('options', { context: 'page', tabId: 'tab-1', url: pageUrl }))
    router.register(
      endpoint('frame', { context: 'page', tabId: 'tab-1', frameId: 3, url: `${pageUrl}?frame` })
    )

    router.handle('options', { t: 'msg', id: 1, target: {}, data: { handler: 'initializeFrame' } })
    const [deliver] = take('bg')
    // The page names itself as Chrome spells it; `origin` is the one its `location` reads.
    expect(deliver.sender).toEqual({
      id: EXT,
      url: `chrome-extension://${EXT}/pages/options.html`,
      origin: `https://${EXT}.ext.zenium.invalid`,
      tab: { id: 1, url: 'https://page.example/' },
      frameId: 0,
      documentId: 'options',
      documentLifecycle: 'active'
    })
    // The two compares a background makes of `sender.origin` cannot both hold on one string on
    // the phone: Tampermonkey's `sender.origin === location.origin` (its own page's, the served
    // one, unforgeable) holds; Google Scholar PDF Reader's `sender.origin === 'chrome-extension://'
    // + chrome.runtime.id` does not (the one-realm limit, rounds 2 and 9). A prefix compare on
    // `sender.url` reads Chrome's spelling.
    const sender = deliver.sender as { url: string; origin: string }
    expect(sender.origin).toBe(new URL(pageUrl).origin)
    expect(sender.origin).not.toBe(`chrome-extension://${EXT}`)
    expect(sender.url.startsWith(`chrome-extension://${EXT}/`)).toBe(true)
    // The page's own iframe carries its frame id; the popup has no tab and no frame.
    router.handle('frame', { t: 'msg', id: 2, target: {}, data: 'sub' })
    expect((take('bg')[0].sender as Record<string, unknown>).frameId).toBe(3)
    router.handle('popup', { t: 'msg', id: 3, target: {}, data: 'pop' })
    const fromPopup = take('bg')[0].sender as Record<string, unknown>
    expect(fromPopup.tab).toBeUndefined()
    expect(fromPopup.frameId).toBeUndefined()

    // tabs.sendMessage to the tab reaches the page hosted in it (and its frame on request).
    for (const ep of ['options', 'frame', 'popup']) take(ep)
    router.handle('bg', { t: 'msg', id: 4, target: { tabId: 1, options: null }, data: 'hi' })
    expect(take('options')).toHaveLength(1)
    expect(take('frame')).toHaveLength(1)
    expect(take('popup')).toEqual([])
    router.handle('bg', {
      t: 'msg',
      id: 5,
      target: { tabId: 1, options: { frameId: 3 } },
      data: 'hi'
    })
    expect(take('options')).toEqual([])
    expect(take('frame')).toHaveLength(1)
  })
})

describe('ports', () => {
  it('fans out 1:N, queues early messages, and disconnects when the last acceptor leaves', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.register(endpoint('popup', { context: 'popup', tabId: null }))

    router.handle('cs', {
      t: 'connect',
      portId: 'cs:1',
      name: 'chan',
      target: { extensionId: null }
    })
    expect(take('bg')).toEqual([
      { t: 'portConnect', portId: 'cs:1', name: 'chan', sender: expect.any(Object) }
    ])
    expect(take('popup')).toHaveLength(1)

    // Posted before anyone accepted: queued until every offered endpoint answered.
    router.handle('cs', { t: 'portMsg', portId: 'cs:1', data: 'early' })
    expect(take('bg')).toEqual([])
    router.handle('popup', { t: 'portAccept', portId: 'cs:1', accept: false })
    router.handle('bg', { t: 'portAccept', portId: 'cs:1', accept: true })
    expect(take('cs')).toEqual([{ t: 'portAccept', portId: 'cs:1', accept: true }])
    expect(take('bg')).toEqual([{ t: 'portMsg', portId: 'cs:1', data: 'early' }])
    expect(take('popup')).toEqual([])

    router.handle('bg', { t: 'portMsg', portId: 'cs:1', data: 'from-bg' })
    expect(take('cs')).toEqual([{ t: 'portMsg', portId: 'cs:1', data: 'from-bg' }])

    router.handle('bg', { t: 'portDisconnect', portId: 'cs:1' })
    expect(take('cs')).toEqual([{ t: 'portDisconnect', portId: 'cs:1' }])
    expect(router.portsOf('cs')).toEqual([])
  })

  it('reports no receiver when every offered endpoint refuses, and disconnects remotes when the initiator dies', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.register(endpoint('bg', { context: 'background', tabId: null }))
    router.handle('cs', { t: 'connect', portId: 'cs:2', name: '', target: {} })
    take('bg')
    router.handle('bg', { t: 'portAccept', portId: 'cs:2', accept: false })
    expect(take('cs')).toEqual([
      { t: 'portAccept', portId: 'cs:2', accept: false, error: NO_RECEIVER }
    ])

    router.handle('cs', { t: 'connect', portId: 'cs:3', name: '', target: {} })
    take('bg')
    router.handle('bg', { t: 'portAccept', portId: 'cs:3', accept: true })
    take('cs')
    router.unregisterTab('tab-1')
    expect(take('bg')).toEqual([{ t: 'portDisconnect', portId: 'cs:3' }])
    expect(router.all().map((e) => e.id)).toEqual(['bg'])
  })

  it('connects with no receiver at all', () => {
    const { router, take } = setup()
    router.register(endpoint('cs'))
    router.handle('cs', { t: 'connect', portId: 'cs:4', name: '', target: {} })
    expect(take('cs')).toEqual([
      { t: 'portAccept', portId: 'cs:4', accept: false, error: NO_RECEIVER }
    ])
  })
})
