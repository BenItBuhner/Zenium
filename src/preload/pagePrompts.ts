import { contextBridge, ipcRenderer } from 'electron'
import {
  PAGE_PROMPT_CHANNEL,
  type PagePromptAnswer,
  type PagePromptCall
} from '../shared/pagePromptIpc'

type Bridge = (call: PagePromptCall) => PagePromptAnswer

/**
 * `window.print()` and the File System Access pickers for the page's main world. Both open system
 * UI the engine draws outside the page – a print dialog, a file picker – which an AI agent's tab
 * must never show the user (`TabViewEvents.onPagePrompt`). The replacements ask the browser
 * synchronously whose the call is: the user's goes on to the native function as before; on an
 * agent's tab print shows nothing (the agent hears of it), `showOpenFilePicker` becomes an
 * `<input type=file>` chooser – which comes to the agent like any other – and a save or folder
 * picker is refused as a cancelled one would be. Installed in every frame.
 */
export function installPagePrompts(): void {
  const bridge: Bridge = (call) => {
    try {
      const answer = ipcRenderer.sendSync(PAGE_PROMPT_CHANNEL, call) as unknown
      return answer === 'agent' ? 'agent' : 'user'
    } catch {
      return 'user'
    }
  }
  try {
    contextBridge.executeInMainWorld({ func: definePrompts, args: [bridge] })
  } catch (error) {
    console.warn('[zen] page prompts unavailable:', (error as Error).message)
  }
}

interface PickerType {
  accept?: Record<string, string | string[]>
}
interface OpenPickerOptions {
  multiple?: boolean
  types?: PickerType[]
}

/**
 * Runs in the page's main world (serialised, so it closes over nothing). The replacements are own
 * data properties of `window`, as the natives are, so pages that replace them keep working.
 */
function definePrompts(bridge: Bridge): void {
  const w = window as unknown as Record<string, unknown>
  const define = (name: string, fn: (...args: never[]) => unknown): void => {
    Object.defineProperty(window, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: true
    })
  }
  const abort = (): DOMException => new DOMException('The user aborted a request.', 'AbortError')

  const print = window.print
  define('print', function print_(this: Window): void {
    if (bridge({ kind: 'print' }) === 'user') print.call(this)
  })

  const original = (name: string): ((...args: unknown[]) => Promise<unknown>) | null =>
    typeof w[name] === 'function' ? (w[name] as (...args: unknown[]) => Promise<unknown>) : null
  const openPicker = original('showOpenFilePicker')
  const savePicker = original('showSaveFilePicker')
  const directoryPicker = original('showDirectoryPicker')

  // A handle on a file the chooser gave: what pages read from a picked file (`getFile`, its name).
  const handleFor = (file: File): object => {
    const proto = (w.FileSystemFileHandle as { prototype?: object } | undefined)?.prototype
    const handle = Object.create(proto ?? Object.prototype) as Record<string, unknown>
    const own = (key: string, value: unknown): void => {
      Object.defineProperty(handle, key, { value, enumerable: true })
    }
    own('kind', 'file')
    own('name', file.name)
    own('getFile', () => Promise.resolve(file))
    own('isSameEntry', (other: unknown) => Promise.resolve(other === handle))
    own('queryPermission', () => Promise.resolve('granted'))
    own('requestPermission', () => Promise.resolve('granted'))
    own('createWritable', () =>
      Promise.reject(
        new DOMException('The file was handed over for reading only.', 'NotAllowedError')
      )
    )
    return handle
  }

  if (openPicker)
    define(
      'showOpenFilePicker',
      function showOpenFilePicker(this: unknown, options?: OpenPickerOptions) {
        if (bridge({ kind: 'file-system-access', picker: 'open' }) === 'user')
          return openPicker.call(this, options)
        const input = document.createElement('input')
        input.type = 'file'
        input.setAttribute('data-zen-picker', 'open')
        input.multiple = Boolean(options?.multiple)
        const accept = (options?.types ?? []).flatMap((t) =>
          Object.entries(t.accept ?? {}).flatMap(([mime, exts]) => [
            mime,
            ...(Array.isArray(exts) ? exts : [exts])
          ])
        )
        if (accept.length) input.accept = accept.join(',')
        return new Promise((resolve, reject) => {
          input.addEventListener(
            'change',
            () => {
              const files = Array.from(input.files ?? [])
              if (files.length) resolve(files.map(handleFor))
              else reject(abort())
            },
            { once: true }
          )
          input.addEventListener('cancel', () => reject(abort()), { once: true })
          input.click()
        })
      }
    )
  if (savePicker)
    define('showSaveFilePicker', function showSaveFilePicker(this: unknown, ...args: unknown[]) {
      if (bridge({ kind: 'file-system-access', picker: 'save' }) === 'user')
        return savePicker.apply(this, args)
      return Promise.reject(abort())
    })
  if (directoryPicker)
    define('showDirectoryPicker', function showDirectoryPicker(this: unknown, ...args: unknown[]) {
      if (bridge({ kind: 'file-system-access', picker: 'directory' }) === 'user')
        return directoryPicker.apply(this, args)
      return Promise.reject(abort())
    })
}
