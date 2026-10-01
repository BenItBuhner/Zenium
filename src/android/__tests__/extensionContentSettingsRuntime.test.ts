import { NO_INCOGNITO_WINDOW_ERROR } from '@core/extensions/api/contentSettings'
import { INCOGNITO_ERROR, INCOGNITO_SCOPE_ERROR } from '@core/extensions/api/privacy'
import { describe, expect, it } from 'vitest'
import { CONTENT_SETTINGS_PERMISSION_ERROR } from '../extensionContentSettings'
import {
  type Harness,
  ID,
  backgroundUp,
  call,
  harness,
  makeTab,
  manifest,
  record
} from './runtimeHarness'

/*
 * `chrome.contentSettings` through the runtime: Quick Javascript Switcher's shape (the
 * `contentSettings` permission; a worker that reads `javascript.get({ primaryUrl, incognito })`
 * for the tab, sets `javascript.set({ primaryPattern: '*://*.host/*', setting, scope })` on the
 * action click and reloads the tab, toggles `<all_urls>` for every site and clears the regular
 * scope) against the fake Kotlin and the core's permission store – what the content-rules
 * service answers for the next navigation (the word `TabWebView.applyContentRules` sets
 * `WebSettings.javaScriptEnabled` from), the forced push that makes the Kotlin host forget its
 * remembered answers, what the store keeps across a detach and a restart, and the boot-time
 * rebuild before any extension attaches.
 */

const NEWS = 'https://news.example/story'
const SUB = 'https://m.news.example/'
const OTHER = 'https://other.example/'
const QJS = ['tabs', 'contentSettings', 'contextMenus', 'storage']

async function withSwitcher(
  h: Harness,
  permissions = QJS,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  await h.runtime.attach(
    record(h, overrides, manifest({ name: 'Quick Javascript Switcher', permissions }))
  )
  backgroundUp(h, 'bg1', [])
  return 'bg1'
}

const javascript = (
  h: Harness,
  ep: string,
  method: string,
  details: unknown
): Promise<Record<string, unknown>> =>
  call(h, ep, 'contentSettings', method, ['javascript', details])

const stored = (h: Harness): unknown =>
  (h.saved('extensions-runtime.json').contentSettings as Record<string, unknown>)[ID]

describe('AndroidExtensionRuntime: chrome.contentSettings', () => {
  it("Quick Javascript Switcher's shape: the rule decides the next navigation's JavaScript, the host is told to re-ask, the store keeps it across a detach", async () => {
    const h = harness()
    const ep = await withSwitcher(h)
    const pushes = h.pushedRules.length
    expect(pushes).toBeGreaterThan(0)

    // The tab's current setting: the browser's word, allow.
    expect((await javascript(h, ep, 'get', { primaryUrl: NEWS, incognito: false })).result).toEqual(
      { setting: 'allow' }
    )
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(true)

    // The action click: the domain pattern blocked, then `tabs.reload` – the reload's question
    // to the core answers `javascript: false` for the site (and its subdomains), nothing else.
    const set = await javascript(h, ep, 'set', {
      primaryPattern: '*://*.news.example/*',
      setting: 'block',
      scope: 'regular'
    })
    expect(set).toMatchObject({ ok: true, result: null })
    expect(h.permissions.resolve('javascript', NEWS)).toBe('deny')
    expect(h.contentRules.resolveAll(NEWS)).toMatchObject({ javascript: false, images: true })
    expect(h.contentRules.resolveAll(SUB).javascript).toBe(false)
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(true)
    // The Kotlin host drops its remembered answers on a push: the rules service pushed its
    // (unchanged) document once for the change – no line of the user's own moved.
    expect(h.pushedRules).toHaveLength(pushes + 1)
    expect(h.pushedRules[pushes]!.javascript).toEqual({ default: 'allow', sites: {} })
    expect((await javascript(h, ep, 'get', { primaryUrl: NEWS, incognito: false })).result).toEqual(
      { setting: 'block' }
    )
    // The store: by extension and type, the pair of patterns, the value, the scope.
    expect(stored(h)).toEqual({
      javascript: [
        {
          primaryPattern: '*://*.news.example/*',
          secondaryPattern: '<all_urls>',
          setting: 'block',
          scope: 'regular'
        }
      ]
    })

    // The user's own answer for the site ranks below the extension's rule (Chrome's providers'
    // order); it is what remains once the extension clears its rules.
    h.permissions.set('javascript', NEWS, 'allow')
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(false)
    const beforeClear = h.pushedRules.length
    expect(await javascript(h, ep, 'clear', { scope: 'regular' })).toMatchObject({ ok: true })
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(true)
    expect(h.pushedRules).toHaveLength(beforeClear + 1)
    expect(stored(h)).toBeUndefined()
    h.permissions.set('javascript', NEWS, 'deny')
    // `get` reads the browser's answer in Chrome's word.
    expect((await javascript(h, ep, 'get', { primaryUrl: NEWS, incognito: false })).result).toEqual(
      { setting: 'block' }
    )
    h.permissions.set('javascript', NEWS, null)

    // The global toggle: `<all_urls>` blocked, read back through `primaryUrl: "http://*"`.
    await javascript(h, ep, 'set', { primaryPattern: '<all_urls>', setting: 'block' })
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(false)
    expect(
      (await javascript(h, ep, 'get', { primaryUrl: 'http://*', incognito: false })).result
    ).toEqual({ setting: 'block' })
    // The more specific pattern wins within the extension: the domain allowed again under the global block.
    await javascript(h, ep, 'set', { primaryPattern: '*://*.news.example/*', setting: 'allow' })
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(true)
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(false)

    // Disabled: the rules stop deciding; the store keeps them.
    const before = h.pushedRules.length
    await h.runtime.detach(ID)
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(true)
    expect(h.pushedRules).toHaveLength(before + 1)
    expect(stored(h)).toMatchObject({ javascript: [{ primaryPattern: '<all_urls>' }, {}] })

    // Enabled again: the rules decide from the attach, before any page of the extension runs.
    await h.runtime.attach(record(h, {}, manifest({ permissions: QJS })))
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(false)
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(true)

    // Uninstalled: the rules go with it.
    await h.runtime.forget(ID)
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(true)
    expect(h.saved('extensions-runtime.json').contentSettings).toEqual({})
  })

  it('answers the other rows the phone asks the core about: images per navigation, popups at the blocker, a retired type its fixed value', async () => {
    const h = harness()
    const ep = await withSwitcher(h)
    const pushes = h.pushedRules.length

    await call(h, ep, 'contentSettings', 'set', [
      'images',
      { primaryPattern: 'https://news.example/*', setting: 'block' }
    ])
    expect(h.contentRules.resolveAll(NEWS)).toMatchObject({ images: false, javascript: true })
    expect(h.contentRules.resolveAll(OTHER).images).toBe(true)
    expect(h.pushedRules).toHaveLength(pushes + 1)

    // Pop-ups: the blocker asks `stored('popups', opener)` – the rule is the remembered answer;
    // not a navigation row, so no push.
    expect(h.permissions.stored('popups', NEWS)).toBeNull()
    await call(h, ep, 'contentSettings', 'set', [
      'popups',
      { primaryPattern: 'https://news.example/*', setting: 'allow' }
    ])
    expect(h.permissions.stored('popups', NEWS)).toBe('allow')
    expect(h.permissions.stored('popups', OTHER)).toBeNull()
    expect(h.pushedRules).toHaveLength(pushes + 1)
    expect(
      (await call(h, ep, 'contentSettings', 'get', ['popups', { primaryUrl: NEWS }])).result
    ).toEqual({ setting: 'allow' })

    // Plug-ins are gone from Chrome: always `block`, a `set` accepted and kept nowhere.
    expect(
      (await call(h, ep, 'contentSettings', 'get', ['plugins', { primaryUrl: NEWS }])).result
    ).toEqual({ setting: 'block' })
    expect(
      await call(h, ep, 'contentSettings', 'set', [
        'plugins',
        { primaryPattern: '<all_urls>', setting: 'allow' }
      ])
    ).toMatchObject({ ok: true })
    expect(Object.keys(stored(h) as Record<string, unknown>).sort()).toEqual(['images', 'popups'])
  })

  it('refuses without the permission, and reads and sets incognito rules only for an extension allowed in private tabs while one is open', async () => {
    const plain = harness()
    const ep0 = await withSwitcher(plain, ['tabs', 'storage'])
    const refused = await javascript(plain, ep0, 'get', { primaryUrl: NEWS })
    expect(refused.ok).toBe(false)
    expect(refused.error).toBe(CONTENT_SETTINGS_PERMISSION_ERROR)

    const h = harness()
    const ep = await withSwitcher(h)
    expect((await javascript(h, ep, 'get', { primaryUrl: NEWS, incognito: true })).error).toBe(
      INCOGNITO_ERROR
    )
    expect(
      (
        await javascript(h, ep, 'set', {
          primaryPattern: '<all_urls>',
          setting: 'block',
          scope: 'incognito_session_only'
        })
      ).error
    ).toBe(INCOGNITO_ERROR)

    const allowed = harness()
    const epA = await withSwitcher(allowed, QJS, { allowPrivate: true })
    expect(
      (await javascript(allowed, epA, 'get', { primaryUrl: NEWS, incognito: true })).error
    ).toBe(NO_INCOGNITO_WINDOW_ERROR)
    expect(
      (
        await javascript(allowed, epA, 'set', {
          primaryPattern: '<all_urls>',
          setting: 'block',
          scope: 'incognito_session_only'
        })
      ).error
    ).toBe(INCOGNITO_SCOPE_ERROR)

    // A private tab open: the incognito rule decides the private tab's navigation alone and
    // ends with the session (not in the store).
    allowed.tabs.p1 = makeTab('p1', NEWS, 'private')
    allowed.notifyState()
    expect(
      await javascript(allowed, epA, 'set', {
        primaryPattern: '<all_urls>',
        setting: 'block',
        scope: 'incognito_session_only'
      })
    ).toMatchObject({ ok: true })
    expect(
      allowed.contentRules.resolveAll(NEWS, { privateContainerId: 'private' }).javascript
    ).toBe(false)
    expect(allowed.contentRules.resolveAll(NEWS).javascript).toBe(true)
    expect(
      (await javascript(allowed, epA, 'get', { primaryUrl: NEWS, incognito: true })).result
    ).toEqual({ setting: 'block' })
    expect(
      (await javascript(allowed, epA, 'get', { primaryUrl: NEWS, incognito: false })).result
    ).toEqual({ setting: 'allow' })
    expect(stored(allowed)).toBeUndefined()
  })

  it('rebuilds the rules from the store at boot, before any extension attaches, and drops them when the manifest lost the permission', async () => {
    const first = harness()
    const ep = await withSwitcher(first)
    await javascript(first, ep, 'set', { primaryPattern: '*://*.news.example/*', setting: 'block' })
    first.runtime.flushSync()

    // A new session: `prime` runs inside the Browser constructor, before the first tab WebView
    // asks for its rules, and the persisted rule decides the first page.
    const h = harness({ files: first.files })
    const rec = record(h, {}, manifest({ name: 'Quick Javascript Switcher', permissions: QJS }))
    h.runtime.store = {
      record: (id) => (id === ID ? rec : undefined),
      records: () => [rec],
      reload: async () => {},
      remove: async () => {},
      requestUpdateCheck: async () => ({ status: 'no_update' })
    }
    const pushes = h.pushedRules.length
    h.runtime.prime()
    expect(h.pushedRules).toHaveLength(pushes + 1)
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(false)
    expect(h.contentRules.resolveAll(OTHER).javascript).toBe(true)
    // The extension attaches: nothing moves.
    await withSwitcher(h)
    expect(h.contentRules.resolveAll(NEWS).javascript).toBe(false)
    expect(
      (await javascript(h, 'bg1', 'get', { primaryUrl: NEWS, incognito: false })).result
    ).toEqual({ setting: 'block' })

    // The manifest without the permission: the primed rule drops out at the attach.
    const lost = harness({ files: first.files })
    const rec2 = record(
      lost,
      {},
      manifest({ name: 'Quick Javascript Switcher', permissions: ['tabs'] })
    )
    lost.runtime.store = {
      record: (id) => (id === ID ? rec2 : undefined),
      records: () => [rec2],
      reload: async () => {},
      remove: async () => {},
      requestUpdateCheck: async () => ({ status: 'no_update' })
    }
    lost.runtime.prime()
    expect(lost.contentRules.resolveAll(NEWS).javascript).toBe(false)
    await withSwitcher(lost, ['tabs'])
    expect(lost.contentRules.resolveAll(NEWS).javascript).toBe(true)
  })
})
