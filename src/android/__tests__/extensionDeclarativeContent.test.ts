import { describe, expect, it } from 'vitest'
import {
  ID,
  backgroundUp,
  call,
  harness,
  makeTab,
  manifest,
  record,
  type Harness
} from './runtimeHarness'

const EVENT = 'onPageChanged'
const MATCHER = 'declarativeContent.PageStateMatcher'
const SHOW = 'declarativeContent.ShowAction'

/** Story Saver's rule: the action shown on its three sites. */
const storySaverRule = (): Record<string, unknown> => ({
  conditions: [
    { instanceType: MATCHER, pageUrl: { hostSuffix: 'instagram.com' } },
    { instanceType: MATCHER, pageUrl: { hostSuffix: 'facebook.com' } },
    { instanceType: MATCHER, pageUrl: { hostEquals: 'web.whatsapp.com' } }
  ],
  actions: [{ instanceType: SHOW }]
})

async function up(h: Harness, over: Record<string, unknown> = {}): Promise<void> {
  const m = manifest({ permissions: ['declarativeContent', 'storage'], ...over })
  await h.runtime.attach(record(h, {}, m))
  backgroundUp(h, 'bg1')
}

function navigate(h: Harness, tabId: string, url: string): void {
  h.tabs[tabId] = makeTab(tabId, url, h.tabs[tabId]?.containerId)
  h.notifyState()
}

describe('chrome.declarativeContent on the phone (Android compat round 24)', () => {
  it("Story Saver's sequence: action.disable() at install, removeRules(undefined), addRules – the action shows on the tabs whose page matches, over the global disable and under the tab's own", async () => {
    const h = harness()
    await up(h)
    const t1 = h.runtime.api.tabs.chromeIdFor('t1')
    expect(h.runtime.api.toolbarAction(ID)?.enabled).toBe(true)
    expect((await call(h, 'bg1', 'action', 'disable', [])).error).toBeUndefined()
    expect(h.runtime.api.toolbarAction(ID)?.enabled).toBe(false)
    // The reset before the add, as the extension runs it: nothing to remove, no complaint.
    const reset = await call(h, 'bg1', 'declarativeContent', 'removeRules', [EVENT, undefined])
    expect(reset.error).toBeUndefined()
    const added = await call(h, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [storySaverRule()]
    ])
    expect(added.error).toBeUndefined()
    // The rule comes back filled in: a minted id, the default priority, the instanceType words on.
    expect(added.result).toEqual([
      {
        id: '_0_',
        priority: 100,
        conditions: [
          { instanceType: MATCHER, pageUrl: { hostSuffix: 'instagram.com' } },
          { instanceType: MATCHER, pageUrl: { hostSuffix: 'facebook.com' } },
          { instanceType: MATCHER, pageUrl: { hostEquals: 'web.whatsapp.com' } }
        ],
        actions: [{ instanceType: SHOW }]
      }
    ])
    // example.com matches no condition: the action stays disabled on the tab.
    expect(h.runtime.api.toolbarAction(ID)?.enabled).toBe(false)
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t1 }])).result).toBe(false)
    // The tab goes to Instagram: the rule holds, the action shows on that tab alone.
    navigate(h, 't1', 'https://www.instagram.com/stories/')
    expect(h.runtime.api.toolbarAction(ID)?.enabled).toBe(true)
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t1 }])).result).toBe(true)
    // The global value is untouched (Chrome's `GetIsVisible` for no tab).
    expect((await call(h, 'bg1', 'action', 'isEnabled', [])).result).toBe(false)
    // Another tab on Facebook shows too; a third elsewhere does not.
    h.tabs.t2 = makeTab('t2', 'https://m.facebook.com/')
    h.tabs.t3 = makeTab('t3', 'https://example.org/')
    h.notifyState()
    const t2 = h.runtime.api.tabs.chromeIdFor('t2')
    const t3 = h.runtime.api.tabs.chromeIdFor('t3')
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t2 }])).result).toBe(true)
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t3 }])).result).toBe(false)
    // The tab's own disable comes first, even where a rule holds; its own enable too.
    await call(h, 'bg1', 'action', 'disable', [t1])
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t1 }])).result).toBe(false)
    await call(h, 'bg1', 'action', 'enable', [t3])
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t3 }])).result).toBe(true)
    // Away from the site the rule lets go.
    navigate(h, 't2', 'https://news.example/')
    expect((await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t2 }])).result).toBe(false)
    // A private tab the extension may not see is no page of its rules.
    h.tabs.p1 = makeTab('p1', 'https://www.instagram.com/', 'private')
    h.notifyState()
    const p1 = h.runtime.api.tabs.chromeIdFor('p1')
    const ext = h.runtime.attached(ID)
    expect(ext && h.runtime.api.declarativeContent.showsAction(ext, p1)).toBe(false)
  })

  it('getRules answers the rules asked for or all of them; removeRules takes the named ones or all; ids are minted past the kept ones', async () => {
    const h = harness()
    await up(h)
    const rule = (host: string, id?: string): Record<string, unknown> => ({
      ...(id ? { id } : {}),
      conditions: [{ instanceType: MATCHER, pageUrl: { hostEquals: host } }],
      actions: [{ instanceType: SHOW }]
    })
    const first = await call(h, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [rule('a.example'), rule('b.example', 'mine'), rule('c.example')]
    ])
    expect((first.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['_0_', 'mine', '_1_'])
    const all = await call(h, 'bg1', 'declarativeContent', 'getRules', [EVENT, undefined])
    expect((all.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['_0_', 'mine', '_1_'])
    const some = await call(h, 'bg1', 'declarativeContent', 'getRules', [
      EVENT,
      ['mine', 'unknown']
    ])
    expect((some.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['mine'])
    // A reused id is refused whole: nothing of the call is added.
    const dup = await call(h, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [rule('d.example'), rule('e.example', 'mine')]
    ])
    expect(dup.error).toBe('Id mine was used multiple times.')
    const after = await call(h, 'bg1', 'declarativeContent', 'getRules', [EVENT, undefined])
    expect((after.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['_0_', 'mine', '_1_'])
    // Named removal, unknown ids ignored; a mint afterwards is past the kept `_1_`.
    await call(h, 'bg1', 'declarativeContent', 'removeRules', [EVENT, ['_0_', 'unknown']])
    const minted = await call(h, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [rule('f.example')]
    ])
    expect((minted.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['_2_'])
    // Everything gone without ids; the count restarts.
    await call(h, 'bg1', 'declarativeContent', 'removeRules', [EVENT, undefined])
    expect(
      (await call(h, 'bg1', 'declarativeContent', 'getRules', [EVENT, undefined])).result
    ).toEqual([])
    const again = await call(h, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [rule('g.example')]
    ])
    expect((again.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['_0_'])
  })

  it("the rules outlive the worker and the session and a disable, and go at uninstall alone (Chrome's ExtensionPrefs)", async () => {
    const h = harness()
    await up(h)
    await call(h, 'bg1', 'declarativeContent', 'addRules', [EVENT, [storySaverRule()]])
    const saved = h.saved('extensions-runtime.json') as {
      declarativeRules: Record<string, Array<{ id: string; actions: string[] }>>
    }
    expect(saved.declarativeRules[ID]).toMatchObject([{ id: '_0_', actions: [SHOW] }])
    // Detached (disabled, or an update's unload) and back: the rules read back.
    const rec = record(h, {}, manifest({ permissions: ['declarativeContent', 'storage'] }))
    await h.runtime.detach(ID)
    await h.runtime.attach(rec)
    backgroundUp(h, 'bg2')
    const kept = await call(h, 'bg2', 'declarativeContent', 'getRules', [EVENT, undefined])
    expect((kept.result as Array<{ id: string }>).map((r) => r.id)).toEqual(['_0_'])
    // A new session over the same file: still there.
    const h2 = harness({ files: h.files })
    await h2.runtime.attach(
      record(h2, {}, manifest({ permissions: ['declarativeContent', 'storage'] }))
    )
    backgroundUp(h2, 'bg1')
    await call(h2, 'bg1', 'action', 'disable', [])
    navigate(h2, 't1', 'https://www.instagram.com/')
    expect(h2.runtime.api.toolbarAction(ID)?.enabled).toBe(true)
    // Uninstalled: gone with the rest of the extension's runtime state.
    await h2.runtime.forget(ID)
    const gone = h2.saved('extensions-runtime.json') as {
      declarativeRules: Record<string, unknown>
    }
    expect(gone.declarativeRules[ID]).toBeUndefined()
  })

  it("refuses in Chrome's words: no permission, no action in the manifest, a bad condition, isBookmarked without bookmarks, the deprecated word by hand", async () => {
    const h = harness()
    await up(h, { permissions: ['storage'] })
    const noPermission = await call(h, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [storySaverRule()]
    ])
    expect(noPermission.error).toBe(
      "The extension does not have the 'declarativeContent' permission."
    )
    const h2 = harness()
    await up(h2, { action: undefined })
    const noAction = await call(h2, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [storySaverRule()]
    ])
    expect(noAction.error).toBe("Can't use declarativeContent.ShowAction without an action")
    const h3 = harness()
    await up(h3)
    const bad = async (rule: Record<string, unknown>): Promise<unknown> =>
      (await call(h3, 'bg1', 'declarativeContent', 'addRules', [EVENT, [rule]])).error
    expect(
      await bad({
        conditions: [{ pageUrl: { hostSuffix: 'x' } }],
        actions: [{ instanceType: SHOW }]
      })
    ).toBe('A condition had no instanceType')
    expect(
      await bad({ conditions: [{ instanceType: SHOW }], actions: [{ instanceType: SHOW }] })
    ).toBe('Expected a condition of type declarativeContent.PageStateMatcher')
    expect(
      await bad({
        conditions: [{ instanceType: MATCHER, hostSuffix: 'x' }],
        actions: [{ instanceType: SHOW }]
      })
    ).toBe("Unknown condition attribute 'hostSuffix'")
    expect(
      await bad({
        conditions: [{ instanceType: MATCHER, pageUrl: 'instagram.com' }],
        actions: [{ instanceType: SHOW }]
      })
    ).toBe("Attribute 'pageUrl' has an invalid type")
    expect(
      await bad({
        conditions: [{ instanceType: MATCHER, isBookmarked: true }],
        actions: [{ instanceType: SHOW }]
      })
    ).toBe("Property 'isBookmarked' requires 'bookmarks' permission")
    expect(await bad({ conditions: [{ instanceType: MATCHER }], actions: [{}] })).toBe(
      'Action is missing instanceType'
    )
    expect(
      await bad({
        conditions: [{ instanceType: MATCHER }],
        actions: [{ instanceType: 'declarativeContent.ShowPageAction' }]
      })
    ).toBe('An action has an invalid instanceType: declarativeContent.ShowPageAction')
    expect(
      await bad({
        conditions: [{ instanceType: MATCHER }],
        actions: [{ instanceType: 'declarativeContent.RequestContentScript', js: ['a.js'] }]
      })
    ).toBe('An action has an invalid instanceType: declarativeContent.RequestContentScript')
    expect(await bad({ actions: [{ instanceType: SHOW }] })).toBe(
      "Error at parameter 'rules': Error at index 0: Missing required property 'conditions'."
    )
    // Nothing of the refused calls was kept.
    expect(
      (await call(h3, 'bg1', 'declarativeContent', 'getRules', [EVENT, undefined])).result
    ).toEqual([])
    // A css condition is accepted and kept, never satisfied here (stated); an empty matcher
    // holds for every page.
    const css = await call(h3, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [
        {
          id: 'css',
          conditions: [{ instanceType: MATCHER, css: ['video'] }],
          actions: [{ instanceType: SHOW }]
        }
      ]
    ])
    expect(css.error).toBeUndefined()
    await call(h3, 'bg1', 'action', 'disable', [])
    const t1 = h3.runtime.api.tabs.chromeIdFor('t1')
    expect((await call(h3, 'bg1', 'action', 'isEnabled', [{ tabId: t1 }])).result).toBe(false)
    await call(h3, 'bg1', 'declarativeContent', 'addRules', [
      EVENT,
      [{ id: 'all', conditions: [{ instanceType: MATCHER }], actions: [{ instanceType: SHOW }] }]
    ])
    expect((await call(h3, 'bg1', 'action', 'isEnabled', [{ tabId: t1 }])).result).toBe(true)
  })
})
