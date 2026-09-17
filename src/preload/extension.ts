import { contextBridge, ipcRenderer } from 'electron'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost
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
 * With context isolation the shim runs in the extension's world through `executeInMainWorld`
 * (the function is serialised, which is why the shim is one self-contained function); without it
 * the preload already shares the extension's globals.
 */
function install(kind: 'frame' | 'worker'): void {
  const host = makeHost(kind)
  try {
    if (!process.contextIsolated) {
      installExtensionApi(host, API_SPEC)
      return
    }
    contextBridge.executeInMainWorld({ func: installExtensionApi, args: [host, API_SPEC] })
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
