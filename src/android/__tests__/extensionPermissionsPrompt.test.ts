import { describe, expect, it } from 'vitest'
import type { RuntimeStoreLink } from '../extensionRuntime'
import { backgroundUp, call, events, harness, ID, manifest, record } from './runtimeHarness'

/**
 * `chrome.permissions.request` on the phone asks the chrome's sheet when the request adds a
 * warning line over what the install prompt showed (Chrome's privilege-increase check), and the
 * user's answer is the request's: Super Simple Highlighter's action click asks for
 * `webNavigation`, `scripting` and the page's site (compat round 25), which Chrome puts to a
 * dialog before anything is granted.
 */
describe('chrome.permissions.request asks before a warning-bearing grant', () => {
  /** Super Simple Highlighter's manifest shape: nothing warns at install, the click's request does. */
  const highlighter = (): Record<string, unknown> =>
    manifest({
      permissions: ['tts', 'contextMenus', 'storage', 'activeTab'],
      optional_permissions: ['scripting', 'webNavigation'],
      optional_host_permissions: ['*://*/*', 'file:///*'],
      host_permissions: [],
      content_scripts: []
    })

  const storeHalf = (
    answer: boolean,
    asked: Array<{ id: string; warnings: string[] }>
  ): RuntimeStoreLink => ({
    record: () => undefined,
    records: () => [],
    reload: async () => {},
    remove: async () => {},
    requestUpdateCheck: async () => ({ status: 'no_update' }),
    confirmPermissionRequest: async (id, warnings) => {
      asked.push({ id, warnings })
      return answer
    }
  })

  const highlighterAsk = {
    permissions: ['webNavigation', 'scripting'],
    origins: ['http://10.0.2.2:8765/*']
  }

  it('puts Chrome’s lines for what the request adds to the sheet and grants the whole request on the user’s yes', async () => {
    const h = harness()
    const asked: Array<{ id: string; warnings: string[] }> = []
    h.runtime.store = storeHalf(true, asked)
    await h.runtime.attach(record(h, {}, highlighter()))
    backgroundUp(h, 'bg1', ['permissions.onAdded'])
    const reply = await call(h, 'bg1', 'permissions', 'request', [highlighterAsk])
    expect(reply.error).toBeUndefined()
    expect(reply.result).toBe(true)
    // `scripting` warns for nothing; `webNavigation` and the site do.
    expect(asked).toEqual([
      {
        id: ID,
        warnings: ['Read and change your data on 10.0.2.2', 'Read your browsing history']
      }
    ])
    expect(events(h, 'bg1', 'permissions.onAdded').map((e) => e.args)).toEqual([[highlighterAsk]])
    expect((await call(h, 'bg1', 'permissions', 'getAll', [])).result).toEqual({
      permissions: ['tts', 'contextMenus', 'storage', 'activeTab', 'webNavigation', 'scripting'],
      origins: ['http://10.0.2.2:8765/*']
    })
    expect(h.kt.hosts.get(ID)).toEqual(['http://10.0.2.2:8765/*'])
  })

  it('answers false and grants nothing, not even the lines that warn for nothing, on the user’s no', async () => {
    const h = harness()
    const asked: Array<{ id: string; warnings: string[] }> = []
    h.runtime.store = storeHalf(false, asked)
    await h.runtime.attach(record(h, {}, highlighter()))
    backgroundUp(h, 'bg1', ['permissions.onAdded'])
    const reply = await call(h, 'bg1', 'permissions', 'request', [highlighterAsk])
    expect(reply.error).toBeUndefined()
    expect(reply.result).toBe(false)
    expect(asked).toHaveLength(1)
    expect(events(h, 'bg1', 'permissions.onAdded')).toEqual([])
    expect(
      (await call(h, 'bg1', 'permissions', 'contains', [{ permissions: ['scripting'] }])).result
    ).toBe(false)
    expect((await call(h, 'bg1', 'permissions', 'getAll', [])).result).toEqual({
      permissions: ['tts', 'contextMenus', 'storage', 'activeTab'],
      origins: []
    })
    expect(h.kt.hosts.get(ID)).toBeUndefined()
  })

  it('grants without a question what adds no line: a permission without a warning, a site the install prompt already named', async () => {
    const h = harness()
    const asked: Array<{ id: string; warnings: string[] }> = []
    h.runtime.store = storeHalf(false, asked)
    // A content script on example.com warned "Read and change your data on example.com" at
    // install; an optional host permission for the same site adds nothing to say.
    await h.runtime.attach(
      record(
        h,
        {},
        manifest({
          permissions: ['storage'],
          optional_permissions: ['scripting'],
          optional_host_permissions: ['https://example.com/*'],
          host_permissions: []
        })
      )
    )
    backgroundUp(h, 'bg1', ['permissions.onAdded'])
    expect(
      (await call(h, 'bg1', 'permissions', 'request', [{ permissions: ['scripting'] }])).result
    ).toBe(true)
    expect(
      (await call(h, 'bg1', 'permissions', 'request', [{ origins: ['https://example.com/*'] }]))
        .result
    ).toBe(true)
    expect(asked).toEqual([])
    expect(events(h, 'bg1', 'permissions.onAdded')).toHaveLength(2)
    expect(h.kt.hosts.get(ID)).toEqual(['https://example.com/*'])
  })

  it('a runtime without its store half has no sheet to ask and grants, as before the sheet', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, highlighter()))
    backgroundUp(h, 'bg1')
    expect((await call(h, 'bg1', 'permissions', 'request', [highlighterAsk])).result).toBe(true)
    expect(
      (await call(h, 'bg1', 'permissions', 'contains', [{ permissions: ['webNavigation'] }])).result
    ).toBe(true)
  })
})
