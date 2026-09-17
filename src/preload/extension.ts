import { contextBridge, ipcRenderer } from 'electron'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../core/extensions/api/shim'
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
      ipcRenderer.on(EVENT, (_event, namespace: string, event: string, args: unknown[]) => {
        try {
          listener(namespace, event, Array.isArray(args) ? args : [])
        } catch (error) {
          console.error('[zenium] extension event listener failed', error)
        }
      })
    }
  }
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

if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
  install(process.type === 'service-worker' ? 'worker' : 'frame')
}
