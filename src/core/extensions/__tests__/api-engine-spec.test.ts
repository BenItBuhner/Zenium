import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_SCRIPT_NAMESPACES,
  ENGINE_NOOPS,
  ENGINE_SPEC,
  ENGINE_STUB_RESULTS,
  engineApiSpec,
  namespaceGranted
} from '../api/engineSpec'
import { installExtensionApi, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test pokes at the patched globals
type Any = any

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
      // The `system` holder has no permission of its own: any `system.*` one makes it.
      const held = name === 'system' ? ['system.display'] : [name]
      expect(namespaceGranted(name, held, mv2Only ? 2 : 3)).toBe(true)
    }
  })

  it('makes chrome.system with any system.* permission only, each member with its own', () => {
    // Chrome has no `chrome.system` for an extension holding none of them: Coinbase Wallet's
    // worker feature-detects `chrome.system?.cpu?.getInfo` before it reads the CPU load, and a
    // holder that was always there passed the test and then rejected.
    expect(namespaceGranted('system', ['tabs', 'storage'], 3)).toBe(false)
    expect(namespaceGranted('system', ['system'], 3)).toBe(false)
    for (const p of ['system.cpu', 'system.memory', 'system.display', 'system.storage']) {
      expect(namespaceGranted('system', [p], 3)).toBe(true)
      expect(namespaceGranted(p, [p], 3)).toBe(true)
      expect(
        namespaceGranted(
          p,
          ['system.cpu', 'system.memory', 'system.display', 'system.storage'].filter(
            (q) => q !== p
          ),
          3
        )
      ).toBe(false)
    }
    const none = engineApiSpec({
      permissions: ['tabs', 'storage'],
      manifestVersion: 3,
      context: 'page'
    })
    expect(none.system).toBeUndefined()
    expect(none['system.display']).toBeUndefined()
    const display = engineApiSpec({
      permissions: ['system.display'],
      manifestVersion: 3,
      context: 'page'
    })
    expect(display.system?.permissions).toEqual([
      'system.cpu',
      'system.memory',
      'system.display',
      'system.storage'
    ])
    expect(display['system.display']?.permissions).toEqual(['system.display'])
    expect(display['system.storage']).toBeUndefined()
  })

  it('makes every permission-gated namespace of the browser layer exist once declared', () => {
    // VeePN, NordVPN and Browsec read `chrome.proxy.settings`, Claude `chrome.debugger.onEvent`
    // and Read&Write `chrome.gcm.onMessage` in their workers' first statements: Chrome has the
    // namespace once the permission is declared, and a missing one was a TypeError there.
    for (const name of [
      'proxy',
      'gcm',
      'debugger',
      'topSites',
      'tts',
      'contentSettings',
      'printerProvider'
    ]) {
      expect(namespaceGranted(name, [name], 3), name).toBe(true)
      expect(namespaceGranted(name, [], 3), name).toBe(false)
    }
    const spec = engineApiSpec({
      permissions: ['proxy', 'gcm', 'debugger', 'privacy', 'contentSettings', 'printerProvider'],
      manifestVersion: 3,
      context: 'page'
    })
    // Save to Google Drive's worker registers its printer listeners in its constructor: the
    // namespace is Chrome's shape of a print destination nothing asks for yet, four events.
    expect(spec.printerProvider.shape).toBe(true)
    expect(spec.printerProvider.methods).toEqual({})
    expect(Object.keys(spec.printerProvider.events)).toEqual([
      'onGetPrintersRequested',
      'onGetUsbPrinterInfoRequested',
      'onGetCapabilityRequested',
      'onPrintRequested'
    ])
    // The ChromeSetting and ContentSetting shapes travel with a namespace the engine table
    // leaves alone (`proxy.settings`, `contentSettings.cookies`); `privacy`'s are the engine's
    // own (`engine.ts`), so the shim must not replace them; `gcm` stays the layer's inert shape.
    expect(spec.proxy.ownSettings).toEqual(['settings'])
    expect(spec.proxy.events.onProxyError).toEqual({})
    expect(spec.proxy.constants?.Mode).toMatchObject({ PAC_SCRIPT: 'pac_script' })
    expect(spec.privacy.settings).toBeUndefined()
    expect(spec.contentSettings.contentSettings).toContain('cookies')
    expect(spec.gcm.shape).toBe(true)
    expect(spec.gcm.methods.register.inert).toEqual({ error: 'GCM_DISABLED' })
    expect(spec.gcm.events.onMessage).toEqual({})
    expect(spec.debugger.events.onEvent).toEqual({})
    expect(spec.debugger.methods.attach.inert).toBeUndefined()
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

  it('answers the omnibox setter quietly and lets every sidePanel member reach the host', () => {
    // The phone has no omnibox keyword; Raindrop.io, OneTab and Bitwarden call the setter while
    // starting. The side panel is hosted in the runtime's sheet (`android/extensionSidePanel.ts`):
    // a context-side no-op for `setPanelBehavior` would leave the toolbar tap opening the popup
    // (Tag Assistant's action click opens its panel).
    expect(ENGINE_NOOPS.has('omnibox.setDefaultSuggestion')).toBe(true)
    for (const method of Object.keys(ENGINE_SPEC.sidePanel.methods)) {
      const key = `sidePanel.${method}`
      expect(ENGINE_NOOPS.has(key), key).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(ENGINE_STUB_RESULTS, key), key).toBe(false)
    }
    expect(Object.keys(ENGINE_SPEC.sidePanel.events)).toEqual(['onOpened', 'onClosed'])
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

  it('builds proxy.settings, gcm and debugger on a bare chrome, as the WebView leaves it', async () => {
    // The phone has no native namespace to patch: what the shim builds from the merged table is
    // all an extension finds. The three workers' first statements, in order.
    const g = globalThis as Record<string, Any>
    const manifest = {
      manifest_version: 3,
      name: 'Probe',
      version: '1.0',
      permissions: ['proxy', 'gcm', 'debugger', 'printerProvider']
    }
    const nativeEvent = (): Any => ({
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false)
    })
    const chrome: Any = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getManifest: () => manifest,
        getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
        sendMessage: vi.fn(),
        onMessage: nativeEvent()
      },
      storage: { local: {}, session: {}, onChanged: nativeEvent() }
    }
    Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
    Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
    const calls: Array<{ namespace: string; method: string; args: unknown[] }> = []
    const host: ShimHost = {
      kind: 'worker',
      invoke(namespace, method, args) {
        calls.push({ namespace, method, args })
        return Promise.resolve({
          ok: true,
          value: { value: { mode: 'system' }, levelOfControl: 'not_controllable' }
        })
      },
      notify: vi.fn(),
      onEvent: vi.fn()
    }
    try {
      installExtensionApi(
        host,
        engineApiSpec({ permissions: manifest.permissions, manifestVersion: 3, context: 'page' })
      )
      chrome.proxy.settings.onChange.addListener(() => {})
      await expect(chrome.proxy.settings.get({})).resolves.toEqual({
        value: { mode: 'system' },
        levelOfControl: 'not_controllable'
      })
      expect(calls).toEqual([{ namespace: 'proxy', method: 'get', args: ['settings', {}] }])
      expect(chrome.proxy.Mode.FIXED_SERVERS).toBe('fixed_servers')
      chrome.gcm.onMessage.addListener(() => {})
      await expect(chrome.gcm.register(['1234'])).rejects.toThrow('GCM_DISABLED')
      chrome.debugger.onEvent.addListener(() => {})
      chrome.debugger.onDetach.addListener(() => {})
      expect(chrome.debugger.DetachReason.TARGET_CLOSED).toBe('target_closed')
      // Save to Google Drive's three printer listeners, in its constructor's order.
      const printers = vi.fn()
      chrome.printerProvider.onGetPrintersRequested.addListener(printers)
      chrome.printerProvider.onGetCapabilityRequested.addListener(() => {})
      chrome.printerProvider.onPrintRequested.addListener(() => {})
      expect(chrome.printerProvider.onGetPrintersRequested.hasListener(printers)).toBe(true)
      // Not declared: not there, as Chrome has it.
      expect(chrome.tts).toBeUndefined()
      expect(chrome.topSites).toBeUndefined()
    } finally {
      delete g.chrome
      delete g.browser
    }
  })
})
