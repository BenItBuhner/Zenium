import { describe, expect, it } from 'vitest'
import {
  CONTENT_SCRIPT_NAMESPACES,
  ENGINE_SPEC,
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
})
