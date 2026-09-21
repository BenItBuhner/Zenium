import { describe, expect, it } from 'vitest'
import { expiredLine, parseSetCookie, permittedUrls, setCookieLine } from '../extensionCookies'
import {
  type Harness,
  ID,
  backgroundUp,
  call,
  events,
  harness,
  hello,
  makeTab,
  manifest,
  record
} from './runtimeHarness'

async function withCookies(
  h: Harness,
  overrides: Record<string, unknown> = {},
  recordOverrides: Record<string, unknown> = {}
): Promise<void> {
  await h.runtime.attach(
    record(
      h,
      recordOverrides,
      manifest({
        permissions: ['cookies', 'storage'],
        host_permissions: ['*://*.example.com/*', '*://api.test/*'],
        ...overrides
      })
    )
  )
  backgroundUp(h, 'bg1', ['cookies.onChanged'])
}

describe('chrome.cookies over the WebView jar', () => {
  it('gets, lists and sorts cookies of a URL, with the attributes GET_COOKIE_INFO lists', async () => {
    const h = harness()
    await withCookies(h)
    const jar = h.kt.jar()
    jar.set('https://www.example.com/', 'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax')
    jar.set('https://www.example.com/app/x', 'pref=dark; Domain=.example.com; Path=/app')
    jar.set('https://other.test/', 'foreign=1')

    const got = await call(h, 'bg1', 'cookies', 'get', [
      { url: 'https://www.example.com/app/', name: 'sid' }
    ])
    expect(got.ok).toBe(true)
    expect(got.result).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'www.example.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      storeId: '0'
    })

    const all = await call(h, 'bg1', 'cookies', 'getAll', [{ url: 'https://www.example.com/app/' }])
    const names = (all.result as Array<{ name: string; path: string }>).map((c) => c.name)
    // The longer path first, as Chrome orders them.
    expect(names).toEqual(['pref', 'sid'])
    const pref = (all.result as Array<Record<string, unknown>>)[0]
    expect(pref).toMatchObject({ domain: '.example.com', hostOnly: false, path: '/app' })

    const missing = await call(h, 'bg1', 'cookies', 'get', [
      { url: 'https://www.example.com/', name: 'nope' }
    ])
    expect(missing.result).toBeNull()
  })

  it('refuses URLs outside the host permissions with Chrome’s message', async () => {
    const h = harness()
    await withCookies(h)
    const reply = await call(h, 'bg1', 'cookies', 'get', [
      { url: 'https://other.test/', name: 'foreign' }
    ])
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe('No host permissions for cookies at url: "https://other.test/".')
    const bad = await call(h, 'bg1', 'cookies', 'get', [{ url: 'nope', name: 'x' }])
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('Invalid url: "nope".')
  })

  it('lists across the permitted hosts without a url, honouring the domain and name filters', async () => {
    const h = harness()
    await withCookies(h)
    const jar = h.kt.jar()
    jar.set('https://example.com/', 'a=1; Domain=.example.com')
    jar.set('https://api.test/', 'b=2')
    jar.set('https://other.test/', 'c=3')

    const all = await call(h, 'bg1', 'cookies', 'getAll', [{}])
    const names = (all.result as Array<{ name: string }>).map((c) => c.name).sort()
    expect(names).toEqual(['a', 'b'])

    const byDomain = await call(h, 'bg1', 'cookies', 'getAll', [{ domain: 'example.com' }])
    expect((byDomain.result as Array<{ name: string }>).map((c) => c.name)).toEqual(['a'])

    const byName = await call(h, 'bg1', 'cookies', 'getAll', [{ name: 'b' }])
    expect((byName.result as Array<{ name: string }>).map((c) => c.name)).toEqual(['b'])
    // A domain the extension has no permission for lists nothing even when asked for.
    const foreign = await call(h, 'bg1', 'cookies', 'getAll', [{ domain: 'other.test' }])
    expect(foreign.result).toEqual([])
  })

  it('sets a cookie through the jar, returns it and raises onChanged (overwrite first)', async () => {
    const h = harness()
    await withCookies(h)
    const set = await call(h, 'bg1', 'cookies', 'set', [
      {
        url: 'https://www.example.com/',
        name: 'theme',
        value: 'dark',
        domain: '.example.com',
        path: '/',
        secure: true,
        expirationDate: 4102444800
      }
    ])
    expect(set.ok).toBe(true)
    expect(set.result).toMatchObject({
      name: 'theme',
      value: 'dark',
      domain: '.example.com',
      hostOnly: false,
      secure: true,
      session: false,
      expirationDate: 4102444800
    })
    expect(h.kt.calledWith('ext.cookies.write')).toEqual([
      {
        container: 'default',
        url: 'https://www.example.com/',
        cookie:
          'theme=dark; Domain=.example.com; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Secure'
      }
    ])
    let changed = events(h, 'bg1', 'cookies.onChanged')
    expect(changed).toHaveLength(1)
    expect((changed[0].args as unknown[])[0]).toMatchObject({
      removed: false,
      cause: 'explicit',
      cookie: { name: 'theme', value: 'dark' }
    })

    await call(h, 'bg1', 'cookies', 'set', [
      { url: 'https://www.example.com/', name: 'theme', value: 'light', domain: '.example.com' }
    ])
    changed = events(h, 'bg1', 'cookies.onChanged')
    expect(changed).toHaveLength(3)
    expect((changed[1].args as unknown[])[0]).toMatchObject({
      removed: true,
      cause: 'overwrite',
      cookie: { name: 'theme', value: 'dark' }
    })
    expect((changed[2].args as unknown[])[0]).toMatchObject({
      removed: false,
      cause: 'explicit',
      cookie: { name: 'theme', value: 'light' }
    })
  })

  it('sets a cookie under a path the URL is not on and answers it (Keepa’s /extension cookies through https://keepa.com)', async () => {
    const h = harness()
    await withCookies(h)
    const set = await call(h, 'bg1', 'cookies', 'set', [
      {
        url: 'https://www.example.com',
        path: '/extension',
        name: 'optOut_crawl',
        value: '0',
        secure: true,
        expirationDate: 4102444800
      }
    ])
    expect(set.ok).toBe(true)
    expect(set.result).toMatchObject({
      name: 'optOut_crawl',
      value: '0',
      path: '/extension',
      domain: 'www.example.com',
      hostOnly: true,
      secure: true
    })
    // Stored once, under its own path; a request to the site's root does not carry it.
    expect(h.kt.jar().cookies.map((c) => `${c.name}@${c.path}`)).toEqual(['optOut_crawl@/extension'])
    expect(h.kt.jar().pairs('https://www.example.com/')).toEqual([])
    expect(h.kt.jar().pairs('https://www.example.com/extension/x')).toEqual(['optOut_crawl=0'])
    expect(events(h, 'bg1', 'cookies.onChanged')).toHaveLength(1)

    // The second set of the same cookie is an overwrite, found under the path too.
    await call(h, 'bg1', 'cookies', 'set', [
      { url: 'https://www.example.com', path: '/extension', name: 'optOut_crawl', value: '1' }
    ])
    const changed = events(h, 'bg1', 'cookies.onChanged')
    expect(changed).toHaveLength(3)
    expect((changed[1].args as unknown[])[0]).toMatchObject({
      removed: true,
      cause: 'overwrite',
      cookie: { name: 'optOut_crawl', value: '0', path: '/extension' }
    })
  })

  it('reports a refused write as Chrome does', async () => {
    const h = harness()
    await withCookies(h)
    // A Secure cookie cannot be set from an http URL; the jar refuses it.
    await h.runtime.attach(
      record(
        h,
        {},
        manifest({ permissions: ['cookies'], host_permissions: ['http://plain.example.com/*'] })
      )
    )
    const reply = await call(h, 'bg1', 'cookies', 'set', [
      { url: 'http://plain.example.com/', name: 's', value: '1', secure: true }
    ])
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe('Failed to parse or set cookie named "s".')
  })

  it('removes the cookie a request would send and tells what it removed', async () => {
    const h = harness()
    await withCookies(h)
    const jar = h.kt.jar()
    jar.set('https://www.example.com/', 'sid=abc; Path=/')
    jar.set('https://www.example.com/deep/x', 'sid=deep; Path=/deep')
    const removed = await call(h, 'bg1', 'cookies', 'remove', [
      { url: 'https://www.example.com/deep/', name: 'sid' }
    ])
    expect(removed.result).toEqual({
      url: 'https://www.example.com/deep/',
      name: 'sid',
      storeId: '0'
    })
    // The `/deep` one went (the longest path wins); the `/` one stays.
    expect(jar.cookies.map((c) => `${c.name}@${c.path}`)).toEqual(['sid@/'])
    const changed = events(h, 'bg1', 'cookies.onChanged')
    expect((changed.at(-1)?.args as unknown[])[0]).toMatchObject({
      removed: true,
      cause: 'explicit',
      cookie: { name: 'sid', value: 'deep', path: '/deep' }
    })
    const nothing = await call(h, 'bg1', 'cookies', 'remove', [
      { url: 'https://www.example.com/', name: 'gone' }
    ])
    expect(nothing.result).toBeNull()
  })

  it('maps containers to cookie stores: the default one, the private one only when allowed', async () => {
    const h = harness()
    await withCookies(h)
    h.tabs.p1 = makeTab('p1', 'https://www.example.com/', 'private')
    h.tabs.w1 = makeTab('w1', 'https://www.example.com/', 'work')
    h.notifyState()
    const stores = await call(h, 'bg1', 'cookies', 'getAllCookieStores', [])
    const ids = h.runtime.api.tabs
    expect(stores.result).toEqual([
      { id: '0', tabIds: [ids.chromeIdFor('t1')] },
      { id: 'work', tabIds: [ids.chromeIdFor('w1')] }
    ])
    const denied = await call(h, 'bg1', 'cookies', 'getAll', [{ storeId: '1' }])
    expect(denied.ok).toBe(false)
    expect(denied.error).toBe('Invalid cookie store id: "1".')

    // Store "work" reads the work container's jar, not the default one.
    h.kt.jar('work').set('https://www.example.com/', 'w=1')
    h.kt.jar().set('https://www.example.com/', 'd=1')
    const work = await call(h, 'bg1', 'cookies', 'getAll', [
      { url: 'https://www.example.com/', storeId: 'work' }
    ])
    expect(
      (work.result as Array<{ name: string; storeId: string }>).map((c) => [c.name, c.storeId])
    ).toEqual([['w', 'work']])
  })

  it('lets an extension allowed in private tabs use the private store', async () => {
    const h = harness()
    await withCookies(h, {}, { allowPrivate: true })
    h.tabs.p1 = makeTab('p1', 'https://www.example.com/', 'private')
    h.notifyState()
    const stores = await call(h, 'bg1', 'cookies', 'getAllCookieStores', [])
    const ids = h.runtime.api.tabs
    expect(stores.result).toEqual([
      { id: '0', tabIds: [ids.chromeIdFor('t1')] },
      { id: '1', tabIds: [ids.chromeIdFor('p1')] }
    ])
    h.kt.jar('private').set('https://www.example.com/', 'p=1')
    const list = await call(h, 'bg1', 'cookies', 'getAll', [
      { url: 'https://www.example.com/', storeId: '1' }
    ])
    expect((list.result as Array<{ name: string }>).map((c) => c.name)).toEqual(['p'])
  })

  it('reads a content script’s own container by default', async () => {
    const h = harness()
    await withCookies(h)
    h.tabs.w1 = makeTab('w1', 'https://www.example.com/', 'work')
    h.notifyState()
    hello(h, 'cs1', 'content', { tabId: 'w1', url: 'https://www.example.com/' })
    h.kt.jar('work').set('https://www.example.com/', 'w=1')
    const reply = await call(h, 'cs1', 'cookies', 'getAll', [{ url: 'https://www.example.com/' }])
    expect(
      (reply.result as Array<{ name: string; storeId: string }>).map((c) => [c.name, c.storeId])
    ).toEqual([['w', 'work']])
  })

  it('falls back to name=value pairs on a WebView without GET_COOKIE_INFO', async () => {
    const h = harness()
    h.kt.detailedCookies = false
    await withCookies(h)
    h.kt.jar().set('https://www.example.com/', 'sid=abc; Path=/; HttpOnly')
    const reply = await call(h, 'bg1', 'cookies', 'get', [
      { url: 'https://www.example.com/', name: 'sid' }
    ])
    // What the pair reading cannot know is reported as Chrome's defaults.
    expect(reply.result).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'www.example.com',
      hostOnly: true,
      path: '/',
      httpOnly: false,
      session: true
    })
  })

  it('requires the cookies permission', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['storage'] })))
    backgroundUp(h, 'bg1')
    const reply = await call(h, 'bg1', 'cookies', 'getAll', [{}])
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe("The 'cookies' permission is required.")
  })

  it('ignores an activeTab-granted URL for cookies of other hosts but allows the granted tab’s', async () => {
    const h = harness()
    await withCookies(h, { permissions: ['cookies', 'activeTab'], host_permissions: [] })
    h.kt.jar().set('https://example.com/', 'a=1')
    const before = await call(h, 'bg1', 'cookies', 'get', [
      { url: 'https://example.com/', name: 'a' }
    ])
    expect(before.ok).toBe(false)
    // The toolbar click grants activeTab on t1 (https://example.com/).
    h.runtime.openPopup(ID)
    const after = await call(h, 'bg1', 'cookies', 'get', [
      { url: 'https://example.com/', name: 'a' }
    ])
    expect(after.ok).toBe(true)
    expect(after.result).toMatchObject({ name: 'a', value: '1' })
  })
})

describe('Set-Cookie syntax helpers', () => {
  it('parses what getCookieInfo lists, defaulting domain and path from the URL', () => {
    const parsed = parseSetCookie(
      'sid=abc; Domain=example.com; Path=/app; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Secure; HttpOnly; SameSite=None',
      'https://www.example.com/app/x',
      0
    )
    expect(parsed).toEqual({
      name: 'sid',
      value: 'abc',
      domain: '.example.com',
      hostOnly: false,
      path: '/app',
      secure: true,
      httpOnly: true,
      session: false,
      expirationDate: 4102444800,
      sameSite: 'no_restriction'
    })
    expect(parseSetCookie('bare=1', 'https://www.example.com/a/b/c', 0)).toMatchObject({
      domain: 'www.example.com',
      hostOnly: true,
      path: '/a/b',
      session: true,
      sameSite: 'unspecified'
    })
    // Max-Age wins over Expires.
    expect(
      parseSetCookie(
        'x=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Max-Age=60',
        'https://a.test/',
        1000
      )
    ).toMatchObject({ session: false, expirationDate: 61 })
    expect(parseSetCookie('', 'https://a.test/')).toBeNull()
  })

  it('builds the Set-Cookie lines for set and remove', () => {
    expect(
      setCookieLine({
        name: 'a',
        value: '1',
        domain: '.example.com',
        path: '/p',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: 0
      })
    ).toBe(
      'a=1; Domain=.example.com; Path=/p; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict'
    )
    expect(setCookieLine({ name: 'a', value: '1', sameSite: 'no_restriction' })).toBe(
      'a=1; SameSite=None'
    )
    expect(
      expiredLine({
        name: 'a',
        value: '1',
        domain: '.example.com',
        hostOnly: false,
        path: '/p',
        secure: true,
        httpOnly: false,
        session: true,
        sameSite: 'unspecified',
        storeId: '0'
      })
    ).toBe(
      'a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/p; Domain=.example.com; Secure'
    )
  })

  it('names the concrete hosts of the permitted patterns', () => {
    expect(
      permittedUrls([
        '*://*.example.com/*',
        'https://api.test:8443/v1/*',
        '<all_urls>',
        'http://*/*',
        'file:///*',
        'https://a.test'
      ])
    ).toEqual(['https://example.com/', 'http://example.com/', 'https://api.test/'])
  })
})
