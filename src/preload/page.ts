import { ipcRenderer } from 'electron'
import { installPageScript, type PageScriptFlags } from '../shared/pageScript'
import { installNewTabPage } from '../shared/newTabPageScript'
import type { NewTabPageState } from '../shared/types'
import { isNewTabUrl } from '../shared/url'

/**
 * Runs inside every web page (isolated world). The behaviours – Glance, pinned-tab link rules,
 * the Boost "zap element" picker – live in `shared/pageScript`; this file only supplies
 * Electron's IPC as the transport. No page-visible globals are created.
 *
 * Tabs enable `nodeIntegrationInSubFrames` so the extension API preload reaches extension
 * iframes; the page behaviours stay with the top document, as before.
 */
if (process.isMainFrame) {
  installPageScript({
    send: (message) => ipcRenderer.send('zen:page', message),
    onFlags: (listener) =>
      ipcRenderer.on('zen:page-flags', (_event, next: PageScriptFlags) => listener(next)),
    onZap: (listener) => ipcRenderer.on('zen:zap', (_event, on: boolean) => listener(on))
  })

  // The new tab page is filled by `shared/newTabPageScript` over the same kind of transport.
  // The first state is fetched synchronously so the page paints in its theme from the first
  // frame; the main process checks the sender before answering, so a site cannot ask.
  if (isNewTabUrl(location.href)) {
    installNewTabPage({
      initialState: () => {
        const state: unknown = ipcRenderer.sendSync('zen:newtab-state')
        return state && typeof state === 'object' ? (state as NewTabPageState) : null
      },
      onState: (listener) =>
        ipcRenderer.on('zen:newtab-state', (_event, state: NewTabPageState) => listener(state)),
      send: (action) => ipcRenderer.send('zen:newtab', action)
    })
  }
}
