import { contextBridge, ipcRenderer } from 'electron'
import type { CommandArgs, CommandName, CommandResult, EventName, Events } from '../shared/types'

/**
 * The bridge between Zen's chrome (React renderer) and the main process.
 * Commands are request/response; events stream from main to the renderer.
 */
export interface ZenApi {
  invoke<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>>
  on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void
}

const api: ZenApi = {
  invoke: (name, args) => ipcRenderer.invoke('zen:cmd', name, args),
  on: (name, listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      eventName: string,
      payload: unknown
    ): void => {
      if (eventName === name) listener(payload as Events[typeof name])
    }
    ipcRenderer.on('zen:event', handler)
    return () => ipcRenderer.removeListener('zen:event', handler)
  }
}

contextBridge.exposeInMainWorld('zen', api)
