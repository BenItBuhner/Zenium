import { describe, expect, it } from 'vitest'
import {
  CONTENT_SCRIPT_NAMESPACES,
  ENGINE_NOOPS,
  ENGINE_SPEC,
  ENGINE_STUB_RESULTS,
  engineApiSpec,
  namespaceGranted
} from '../api/engineSpec'
import { API_SPEC } from '../api/spec'

describe('engineApiSpec', () => {
  it('merges the browser layer table with the engine table, engine members winning', () => {
    const spec = engineApiSpec({
      permissions: ['contextMenus', 'webNavigation', 'notifications', 'cookies'],
      manifestVersion: 3,
      context: 'page'
    })
    // Shapes the browser layer ships become routed calls on the emulated engine.
    expect(spec.webNavigation.methods.getFrame.inert).toBeUndefined()
    expect(spec.webNavigation.shape).toBeUndefined()
    expect(spec.notifications.methods.create.inert).toBeUndefined()
    expect(spec.contextMenus.methods.create.keepNative).toBe(true)
    // What the engine does not implement keeps the layer's answer.
    expect(spec.cookies.methods.getPartitionKey.inert).toEqual({ value: { partitionKey: {} } })
    // Browser layer members stay: routed tabs/windows/alarms come from `API_SPEC`.
    expect(spec.tabs.methods.query).toEqual(API_SPEC.tabs.methods.query)
    expect(spec.tabs.methods.executeScript).toBeDefined()
    expect(spec.tabs.constants?.TAB_ID_NONE).toBe(-1)
    expect(spec.tabs.constants?.ZoomSettingsMode).toEqual({
      AUTOMATIC: 'automatic',
      MANUAL: 'manual',
      DISABLED: 'disabled'
    })
    expect(spec.runtime.methods.getURL.keepNative).toBe(true)
    expect(spec.runtime.events.onMessage.keepNative).toBe(true)
    expect(spec.runtime.events.onInstalled).toEqual({})
  })

  it('gates namespaces by permission, manifest version and context', () => {
    const page = engineApiSpec({ permissions: ['storage'], manifestVersion: 3, context: 'page' })
    expect(Object.keys(page)).toContain('tabs')
    expect(Object.keys(page)).toContain('windows')
    expect(Object.keys(page)).toContain('action')
    expect(Object.keys(page)).not.toContain('browserAction')
    expect(Object.keys(page)).not.toContain('cookies')
    expect(Object.keys(page)).not.toContain('declarativeNetRequest')
    const mv2 = engineApiSpec({
      permissions: ['declarativeNetRequestWithHostAccess', 'webRequestBlocking'],
      manifestVersion: 2,
      context: 'page'
    })
    expect(Object.keys(mv2)).toContain('browserAction')
    expect(Object.keys(mv2)).toContain('pageAction')
    expect(Object.keys(mv2)).not.toContain('action')
    expect(Object.keys(mv2)).toContain('declarativeNetRequest')
    expect(Object.keys(mv2)).toContain('webRequest')
    const content = engineApiSpec({
      permissions: ['storage', 'tabs', 'cookies'],
      manifestVersion: 3,
      context: 'content'
    })
    // `storage` is built by the shim itself, so it never appears in the table.
    expect(Object.keys(content).sort()).toEqual(
      [...CONTENT_SCRIPT_NAMESPACES].filter((n) => n !== 'storage').sort()
    )
  })

  it('answers namespaceGranted the way Chrome exposes namespaces', () => {
    expect(namespaceGranted('runtime', [], 3)).toBe(true)
    expect(namespaceGranted('tabs', [], 3)).toBe(true)
    expect(namespaceGranted('storage', [], 3)).toBe(false)
    expect(namespaceGranted('storage', ['storage'], 3)).toBe(true)
    expect(namespaceGranted('action', [], 2)).toBe(false)
    expect(namespaceGranted('browserAction', [], 2)).toBe(true)
    expect(namespaceGranted('nonsense', ['nonsense'], 3)).toBe(false)
  })

  it('has every engine namespace in the permission table', () => {
    for (const name of Object.keys(ENGINE_SPEC)) {
      const mv2Only = name === 'browserAction' || name === 'pageAction'
      expect(namespaceGranted(name, [name], mv2Only ? 2 : 3)).toBe(true)
    }
  })

  it('lets every userScripts member reach the host', () => {
    // Android answers all of them (`extensionApi.ts`, `userScriptsCall`): `configureWorld` is
    // the switch that gives the USER_SCRIPT world its `chrome`, and a context-side no-op in its
    // place resolved the call without the host ever hearing of it (Tampermonkey's and
    // Violentmonkey's content scripts then read `runtime` of undefined on every page).
    for (const method of Object.keys(ENGINE_SPEC.userScripts.methods)) {
      const key = `userScripts.${method}`
      expect(ENGINE_NOOPS.has(key), key).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(ENGINE_STUB_RESULTS, key), key).toBe(false)
    }
  })

  it('answers the omnibox and side-panel setters quietly', () => {
    // The phone has neither; Raindrop.io, OneTab and Bitwarden call them while starting.
    for (const key of [
      'omnibox.setDefaultSuggestion',
      'sidePanel.setOptions',
      'sidePanel.setPanelBehavior'
    ])
      expect(ENGINE_NOOPS.has(key), key).toBe(true)
    // The getters keep rejecting: a quiet nothing would be a lie the caller acts on.
    for (const key of ['sidePanel.getOptions', 'sidePanel.getPanelBehavior', 'sidePanel.open'])
      expect(ENGINE_NOOPS.has(key), key).toBe(false)
  })

  it('lets every declarativeNetRequest member reach the host', () => {
    // The host answers all of them from `core/extensions/dnr` (W2-3): a context-side no-op or
    // stub here would silently swallow `setExtensionActionOptions` (the badge count) or answer
    // `getMatchedRules` with nothing.
    for (const method of Object.keys(ENGINE_SPEC.declarativeNetRequest.methods)) {
      const key = `declarativeNetRequest.${method}`
      expect(ENGINE_NOOPS.has(key), key).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(ENGINE_STUB_RESULTS, key), key).toBe(false)
    }
  })
})
