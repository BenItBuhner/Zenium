/* global chrome */
// The worker's view of `chrome` the moment it starts, as one console line the smoke reads off the
// session's ServiceWorkers `console-message` (smoke.mjs, hookMain's worker-console events).
//
// Zenium's worker preload (src/preload/extension.ts) defines the namespaces Electron's engine
// leaves out of an MV3 worker – `permissions` and `windows` for every extension, `contextMenus`
// for the permission this manifest holds, … – and Electron runs service-worker preloads in
// sandboxed renderers only: under --no-sandbox the line names the engine's own set (dom,
// extension, i18n, management, runtime, storage, tabs for this manifest on Electron 44.4.5).
const probe = {
  permissions: typeof chrome.permissions,
  getAll: typeof (chrome.permissions && chrome.permissions.getAll),
  windows: typeof chrome.windows,
  contextMenus: typeof chrome.contextMenus,
  keys: Object.keys(chrome).sort()
}
console.log('ZENIUM_SMOKE_WORKER_PROBE ' + JSON.stringify(probe))
