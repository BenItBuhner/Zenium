import { PRIVACY_PERMISSION_ERROR } from '@core/extensions/api/privacy'
import { describe, expect, it } from 'vitest'
import {
  PRIVACY_PRIVATE_RULE_SET_ID,
  PRIVACY_RULE_SET_ID,
  doNotTrackScript
} from '../extensionPrivacy'
import { type Harness, ID, backgroundUp, call, harness, manifest, record } from './runtimeHarness'

/*
 * `chrome.privacy` through the runtime: iCloud Passwords' shape (the `privacy` permission, a
 * worker that sets `passwordSavingEnabled`, `doNotTrackEnabled` and `referrersEnabled` at start
 * and listens for the changes) against the fake Kotlin and the core's blocking engine – what
 * the controls map gets, what the engine decides for a document and a subresource, what
 * `ext.privacy.apply` carries, what the store keeps across a detach and a restart, and the
 * boot-time rebuild from the store before any extension attaches.
 */

const LISTENERS = [
  'privacy.services.passwordSavingEnabled.onChange',
  'privacy.websites.doNotTrackEnabled.onChange'
]

async function withPrivacy(h: Harness, permissions = ['privacy', 'storage']): Promise<string> {
  await h.runtime.attach(record(h, {}, manifest({ name: 'iCloud Passwords', permissions })))
  backgroundUp(h, 'bg1', LISTENERS)
  return 'bg1'
}

const document = (url: string, extra: Record<string, unknown> = {}) =>
  ({ url, type: 'main_frame', method: 'GET', partition: 'default', ...extra }) as const

/** The `onChange` events an endpoint received: the runtime emits them as `privacy` + `<category>.<name>.onChange`. */
function changes(h: Harness, ep: string, key: string): unknown[] {
  return h.kt
    .to(ep)
    .filter((m) => m.t === 'event' && `${String(m.ns)}.${String(m.name)}` === key)
    .map((m) => (m.args as unknown[])[0])
}

describe('AndroidExtensionRuntime: chrome.privacy', () => {
  it("iCloud Passwords' three values: stored, published under the desktop's keys, the engine's document rule and the doNotTrack layer, the listener told", async () => {
    const h = harness()
    const ep = await withPrivacy(h)
    expect(h.controls).toEqual([])
    expect(h.kt.privacyLayer).toBeUndefined()

    expect(
      await call(h, ep, 'privacy', 'set', ['services', 'passwordSavingEnabled', { value: false }])
    ).toMatchObject({ ok: true })
    expect(
      (await call(h, ep, 'privacy', 'get', ['services', 'passwordSavingEnabled', {}])).result
    ).toEqual({ value: false, levelOfControl: 'controlled_by_this_extension' })
    expect(h.controls).toEqual([
      { 'passwords.offerToSave': { extensionId: ID, name: 'iCloud Passwords', value: false } }
    ])
    expect(changes(h, ep, 'privacy.services.passwordSavingEnabled.onChange')).toEqual([
      { value: false, levelOfControl: 'controlled_by_this_extension' }
    ])
    // The user's own setting was never written.
    expect(h.passwords.offerToSave).toBe(true)

    await call(h, ep, 'privacy', 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    await call(h, ep, 'privacy', 'set', ['websites', 'referrersEnabled', { value: false }])
    expect(h.controls[h.controls.length - 1]).toEqual({
      'passwords.offerToSave': { extensionId: ID, name: 'iCloud Passwords', value: false },
      'privacy.dnt': { extensionId: ID, name: 'iCloud Passwords', value: true }
    })
    // The engine: a document in a regular partition gets DNT: 1 and loses its Referer; a
    // subresource and a private tab's document are untouched (no extension allowed there).
    expect(h.engine.summary(PRIVACY_RULE_SET_ID)).toMatchObject({
      source: 'builtin',
      enabled: true,
      ruleCount: 1,
      partitions: ['default'],
      attribution: { name: 'iCloud Passwords: chrome.privacy request settings' }
    })
    expect(h.engine.has(PRIVACY_PRIVATE_RULE_SET_ID)).toBe(false)
    expect(h.engine.decide(document('https://news.example/'))).toMatchObject({
      action: 'modifyHeaders',
      requestHeaders: [
        { header: 'DNT', operation: 'set', value: '1' },
        { header: 'Referer', operation: 'remove' }
      ],
      matched: { setId: PRIVACY_RULE_SET_ID, ruleId: 1 }
    })
    expect(
      h.engine.decide(document('https://news.example/f', { type: 'sub_frame' }))
    ).toMatchObject({ action: 'modifyHeaders' })
    expect(h.engine.decide(document('https://news.example/a.js', { type: 'script' }))).toEqual({
      action: 'allow'
    })
    expect(
      h.engine.decide(document('https://news.example/', { partition: 'private', isPrivate: true }))
    ).toEqual({ action: 'allow' })
    // The layer: navigator.doNotTrack '1' in regular tabs' documents from document start.
    expect(h.kt.privacyLayer).toEqual({
      doNotTrack: true,
      doNotTrackPrivate: false,
      script: { on: doNotTrackScript(true), off: doNotTrackScript(false) }
    })
    expect(h.kt.privacyApplies).toBe(1)
    expect(changes(h, ep, 'privacy.websites.doNotTrackEnabled.onChange')).toEqual([
      { value: true, levelOfControl: 'controlled_by_this_extension' }
    ])

    // The store: by extension, setting key and scope.
    expect((h.saved('extensions-runtime.json').privacy as Record<string, unknown>)[ID]).toEqual({
      'services.passwordSavingEnabled': { regular: false },
      'websites.doNotTrackEnabled': { regular: true },
      'websites.referrersEnabled': { regular: false }
    })

    // Disabled: the values stop applying – the map empties, the set goes, the layer says off; the store keeps them.
    await h.runtime.detach(ID)
    expect(h.controls[h.controls.length - 1]).toEqual({})
    expect(h.engine.has(PRIVACY_RULE_SET_ID)).toBe(false)
    expect(h.kt.privacyLayer).toMatchObject({ doNotTrack: false, doNotTrackPrivate: false })
    expect(
      (h.saved('extensions-runtime.json').privacy as Record<string, unknown>)[ID]
    ).toBeDefined()

    // Enabled again: the values apply at attach, before any page of the extension runs.
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['privacy', 'storage'] })))
    expect(h.controls[h.controls.length - 1]).toMatchObject({
      'passwords.offerToSave': { extensionId: ID, value: false },
      'privacy.dnt': { extensionId: ID, value: true }
    })
    expect(h.engine.has(PRIVACY_RULE_SET_ID)).toBe(true)
    expect(h.kt.privacyLayer).toMatchObject({ doNotTrack: true })

    // Uninstalled: the values go with it.
    await h.runtime.forget(ID)
    expect(h.controls[h.controls.length - 1]).toEqual({})
    expect(h.engine.has(PRIVACY_RULE_SET_ID)).toBe(false)
    expect(h.saved('extensions-runtime.json').privacy).toEqual({})
  })

  it('rebuilds the controls from the store at boot, before any extension attaches, and re-applies the rules once the engine is up', async () => {
    const first = harness()
    const ep = await withPrivacy(first)
    await call(first, ep, 'privacy', 'set', ['services', 'passwordSavingEnabled', { value: false }])
    await call(first, ep, 'privacy', 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    first.runtime.flushSync()

    // A new session: the store's records are the registry's; `prime` runs inside the Browser
    // constructor (before `blocking.start()` and the first tab WebView) and publishes from the
    // store. The harness's engine is attached after the runtime is built, as the real one is,
    // so the set waits for `start()`.
    const h = harness({ files: first.files })
    const rec = record(h, {}, manifest({ name: 'iCloud Passwords', permissions: ['privacy'] }))
    h.runtime.store = {
      record: (id) => (id === ID ? rec : undefined),
      records: () => [rec],
      reload: async () => {},
      remove: async () => {},
      requestUpdateCheck: async () => ({ status: 'no_update' })
    }
    h.runtime.prime()
    expect(h.controls).toEqual([
      {
        'passwords.offerToSave': { extensionId: ID, name: 'iCloud Passwords', value: false },
        'privacy.dnt': { extensionId: ID, name: 'iCloud Passwords', value: true }
      }
    ])
    // The engine was up by the time `prime` resolved in the harness, so the set is there already;
    // `start()` re-applies from the same resolution (the persisted copy replaced, not doubled).
    await h.runtime.start()
    expect(h.engine.summary(PRIVACY_RULE_SET_ID)).toMatchObject({ ruleCount: 1 })
    expect(h.engine.decide(document('https://news.example/'))).toMatchObject({
      action: 'modifyHeaders',
      requestHeaders: [{ header: 'DNT', operation: 'set', value: '1' }]
    })
    expect(h.kt.privacyLayer).toMatchObject({ doNotTrack: true })
    // The extension attaches: nothing moves – the same values, now with the manifest's word.
    await withPrivacy(h, ['privacy'])
    expect(h.controls).toHaveLength(1)
    expect(
      (await call(h, 'bg1', 'privacy', 'get', ['websites', 'doNotTrackEnabled', {}])).result
    ).toEqual({ value: true, levelOfControl: 'controlled_by_this_extension' })
  })

  it('is refused without the permission, and a persisted value drops out when the manifest lost it', async () => {
    const first = harness()
    const ep = await withPrivacy(first)
    await call(first, ep, 'privacy', 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    first.runtime.flushSync()

    const h = harness({ files: first.files })
    const rec = record(h, {}, manifest({ name: 'iCloud Passwords', permissions: ['storage'] }))
    h.runtime.store = {
      record: (id) => (id === ID ? rec : undefined),
      records: () => [rec],
      reload: async () => {},
      remove: async () => {},
      requestUpdateCheck: async () => ({ status: 'no_update' })
    }
    h.runtime.prime()
    expect(h.controls).toEqual([
      { 'privacy.dnt': { extensionId: ID, name: 'iCloud Passwords', value: true } }
    ])
    await withPrivacy(h, ['storage'])
    expect(h.controls[h.controls.length - 1]).toEqual({})
    const refused = await call(h, 'bg1', 'privacy', 'get', ['websites', 'doNotTrackEnabled', {}])
    expect(refused.ok).toBe(false)
    expect(refused.error).toBe(PRIVACY_PERMISSION_ERROR)
  })
})
