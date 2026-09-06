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

type Listener = (payload: unknown) => void
const listeners = new Map<string, Set<Listener>>()

// One IPC subscription fans out to every renderer listener (avoids MaxListeners warnings).
ipcRenderer.on('zen:event', (_event, eventName: string, payload: unknown) => {
  const set = listeners.get(eventName)
  if (!set) return
  for (const listener of [...set]) listener(payload)
})

const api: ZenApi = {
  invoke: (name, args) => ipcRenderer.invoke('zen:cmd', name, args),
  on: (name, listener) => {
    let set = listeners.get(name)
    if (!set) {
      set = new Set()
      listeners.set(name, set)
    }
    const wrapped = listener as Listener
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('zen', api)
