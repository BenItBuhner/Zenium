import { contextBridge, ipcRenderer } from 'electron'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost,
  type ShimOptions
} from '../core/extensions/api/shim'
import { API_SPEC } from '../core/extensions/api/spec'

/**
 * The Zenium `chrome.*` / `browser.*` layer for extension contexts. Registered on every
 * persistent session twice: as a frame preload (popup, options, MV2 background page, offscreen,
 * side panel, devtools pages, extension pages opened as tabs) and as a service-worker preload
 * (MV3 background workers). One file for both because a sandboxed preload cannot load a shared
 * chunk; the branch below picks the context.
 *
 * Anything that is not an extension context is left untouched: web pages, their iframes and a
 * site's own service workers see no globals and no IPC from this file.
 */

const CALL = 'zen-ext:call'
const NOTIFY = 'zen-ext:notify'
const EVENT = 'zen-ext:event'
// `USER_SCRIPTS_CHANNELS.toggles` of `shared/userScripts.ts`, spelled out: that module is in the
// page preload's bundle too, and a module two preload entries share becomes a chunk neither
// sandboxed preload can load (the build refuses one; `electron.vite.config.ts`).
const TOGGLES = 'zen-ext:toggles'

/**
 * Transport for the context-side shim: `invoke` and `notify` cross into the main process over
 * Electron's IPC, `onEvent` fans the router's pushes back. The functions cross the context bridge
 * (proxied), so the shim can call them from the extension's own world.
 */
function makeHost(kind: 'frame' | 'worker'): ShimHost {
  return {
    kind,
    invoke: (namespace, method, args) =>
      ipcRenderer.invoke(CALL, namespace, method, args).catch((error: unknown): InvokeResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })),
    notify: (name, payload) => ipcRenderer.send(NOTIFY, name, payload),
    onEvent: (listener) => {
      ipcRenderer.on(
        EVENT,
        (_event, namespace: string, event: string, args: unknown[], delivery: unknown) => {
          try {
            listener(namespace, event, Array.isArray(args) ? args : [], eventDelivery(delivery))
          } catch (error) {
            console.error('[zenium] extension event listener failed', error)
          }
        }
      )
    }
  }
}

/** The router's addressing of a delivery to filtered listeners; absent means everyone. */
function eventDelivery(raw: unknown): EventDelivery | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const matched = Array.isArray(record.matched)
    ? record.matched.filter((id): id is number => typeof id === 'number')
    : []
  return { unfiltered: record.unfiltered === true, matched }
}

/**
 * What the shim installs with, asked synchronously so it holds from the first script on
 * (`HostShimOptions` of `shared/userScripts.ts`): the extension's per-extension toggles
 * (`chrome.userScripts` behind "Allow user scripts"; a toggled namespace that is off throws on
 * access), the content-script storage prelude when the install directory carries one, the
 * permissions the host withheld from the engine's manifest, and the API permissions granted
 * (the permission-gated namespaces follow those). Every toggle off, no prelude, nothing
 * withheld and no grant view when the host cannot be asked.
 */
function optionsFromHost(): ShimOptions {
  const toggles: Record<string, boolean> = { userScripts: false }
  const options: ShimOptions = { toggles }
  try {
    const raw: unknown = ipcRenderer.sendSync(TOGGLES)
    if (raw !== null && typeof raw === 'object') {
      const record = raw as Record<string, unknown>
      const sent = record.toggles
      if (sent !== null && typeof sent === 'object') {
        for (const [key, value] of Object.entries(sent as Record<string, unknown>)) {
          if (typeof value === 'boolean') toggles[key] = value
        }
      }
      if (typeof record.storagePrelude === 'string' && record.storagePrelude.length > 0) {
        options.storagePrelude = record.storagePrelude
      }
      const withheld = record.withheld
      if (withheld !== null && typeof withheld === 'object') {
        const list = (value: unknown): string[] =>
          Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
        const sent = withheld as Record<string, unknown>
        const required = list(sent.required)
        const optional = list(sent.optional)
        if (required.length > 0 || optional.length > 0) options.withheld = { required, optional }
      }
      if (Array.isArray(record.granted)) {
        options.granted = record.granted.filter((p): p is string => typeof p === 'string')
      }
    }
  } catch {
    /* no host: every toggled namespace stays off */
  }
  return options
}

/**
 * With context isolation the shim runs in the extension's world through `executeInMainWorld`
 * (the function is serialised, which is why the shim is one self-contained function); without it
 * the preload already shares the extension's globals.
 */
function install(kind: 'frame' | 'worker'): void {
  const host = makeHost(kind)
  const options = optionsFromHost()
  try {
    if (!process.contextIsolated) {
      installExtensionApi(host, API_SPEC, options)
      return
    }
    contextBridge.executeInMainWorld({
      func: installExtensionApi,
      args: [host, API_SPEC, options]
    })
  } catch (error) {
    console.error('[zenium] extension API layer failed to install', error)
  }
}

/**
 * The document's URL, or the worker's script URL. A service-worker preload world has no
 * `location` of its own; the main world (the worker itself) does.
 */
function contextUrl(): string {
  if (typeof location !== 'undefined' && location) return location.href
  try {
    return String(contextBridge.executeInMainWorld({ func: () => globalThis.location.href }))
  } catch {
    return ''
  }
}

/**
 * Extension documents and workers, including the sub-frames an extension page or a content
 * script embeds (`chrome-extension://` iframes in web pages, `about:blank` children that inherit
 * the extension's origin). Reached in every frame because the hosting views enable
 * `nodeIntegrationInSubFrames`.
 */
function isExtensionContext(): boolean {
  if (contextUrl().startsWith('chrome-extension://')) return true
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
}

if (isExtensionContext()) {
  install(process.type === 'service-worker' ? 'worker' : 'frame')
}
