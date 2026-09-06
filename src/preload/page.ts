import { ipcRenderer } from 'electron'
import { installPageScript, type PageScriptFlags } from '../shared/pageScript'

/**
 * Runs inside every web page (isolated world). The behaviours live in `shared/pageScript`; this
 * file only supplies Electron's IPC as the transport. No page-visible globals are created.
 */
installPageScript({
  send: (message) => ipcRenderer.send('zen:page', message),
  onFlags: (listener) =>
    ipcRenderer.on('zen:page-flags', (_event, next: PageScriptFlags) => listener(next))
})
