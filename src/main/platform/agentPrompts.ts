import { app, dialog, type BrowserWindow, type Debugger } from 'electron'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentUploadFile, FileChooserAnswer, FileChooserRequest } from '../../core/platform'

/**
 * The desktop's side of an AI agent's file choosers (`ElectronTabView.interceptAgentPrompts`):
 * while an agent works a page, Chromium hands every file chooser it would open to the page's
 * DevTools session (`Page.setInterceptFileChooserDialog`) instead of the system's dialog; the core
 * says whose it is (`TabViewEvents.onFileChooser`) and the answer goes back to the input over the
 * protocol – the files (`DOM.setFileInputFiles`, which fires `input` and `change` as a person's
 * pick does), a cancel (the input's `cancel` event), or, for a tab that is not an agent's after
 * all, the system's own dialog shown here.
 */

/** `Page.fileChooserOpened`'s parameters. */
export interface FileChooserOpened {
  frameId?: string
  mode?: 'selectSingle' | 'selectMultiple'
  backendNodeId?: number
}

/** Inline files an agent sent are written here, one private folder per upload. */
let uploadRoot: string | null = null

function uploadsDir(): string {
  if (!uploadRoot) {
    uploadRoot = join(app.getPath('temp'), `zenium-agent-uploads-${process.pid}`)
    app.once('will-quit', clearAgentUploads)
  }
  return uploadRoot
}

/** The uploads written this run go when the browser quits. */
export function clearAgentUploads(): void {
  const root = uploadRoot
  uploadRoot = null
  if (root) rmSync(root, { recursive: true, force: true })
}

/**
 * The paths Chromium reads the files from: an agent's path as given, inline bytes written to a
 * private temporary file under the name the agent gave (the page sees that name).
 */
export async function uploadPaths(files: readonly AgentUploadFile[]): Promise<string[]> {
  const out: string[] = []
  let folder: string | null = null
  for (const file of files) {
    if ('path' in file) {
      out.push(file.path)
      continue
    }
    if (!folder) {
      folder = join(uploadsDir(), randomBytes(8).toString('hex'))
      await mkdir(folder, { recursive: true, mode: 0o700 })
    }
    const path = join(folder, file.name.replace(/[\\/]/g, '_'))
    await writeFile(path, Buffer.from(file.base64, 'base64'), { mode: 0o600 })
    out.push(path)
  }
  return out
}

/**
 * What the chooser's input takes, from its attributes. `data-zen-picker` marks the input the
 * preload's `showOpenFilePicker` stands in with (`preload/pagePrompts.ts`).
 */
async function chooserRequest(
  dbg: Debugger,
  opened: FileChooserOpened
): Promise<FileChooserRequest> {
  let accept: string[] = []
  let folder = false
  let picker = false
  try {
    const described = (await dbg.sendCommand('DOM.describeNode', {
      backendNodeId: opened.backendNodeId
    })) as { node?: { attributes?: string[] } }
    const attrs = described.node?.attributes ?? []
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      const name = attrs[i].toLowerCase()
      if (name === 'accept')
        accept = attrs[i + 1]
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      else if (name === 'webkitdirectory') folder = true
      else if (name === 'data-zen-picker') picker = true
    }
  } catch {
    /* the input went: the answer below finds nothing to fill either */
  }
  return {
    mode: folder ? 'folder' : opened.mode === 'selectMultiple' ? 'multiple' : 'single',
    accept,
    source: picker ? 'file-system-access' : 'input'
  }
}

/** The system's chooser, for a page that intercepts but is not an agent's (any more). */
async function systemChooser(
  parent: BrowserWindow | null,
  request: FileChooserRequest
): Promise<FileChooserAnswer> {
  const extensions = request.accept
    .filter((a) => a.startsWith('.'))
    .map((a) => a.slice(1))
    .filter(Boolean)
  const options: Electron.OpenDialogOptions = {
    properties:
      request.mode === 'folder'
        ? ['openDirectory']
        : request.mode === 'multiple'
          ? ['openFile', 'multiSelections']
          : ['openFile'],
    ...(extensions.length && request.accept.every((a) => a.startsWith('.'))
      ? { filters: [{ name: 'Files', extensions }] }
      : {})
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths.length
    ? { kind: 'cancel' }
    : { kind: 'files', files: result.filePaths.map((path) => ({ path })) }
}

/**
 * Answer an intercepted chooser: ask whose it is, then fill the input, or tell it the chooser was
 * cancelled. `withDebugger` holds the page's session for the commands.
 */
export async function answerFileChooser(
  withDebugger: <T>(fn: (dbg: Debugger) => Promise<T>) => Promise<T>,
  opened: FileChooserOpened,
  ask: ((request: FileChooserRequest) => Promise<FileChooserAnswer>) | undefined,
  parent: () => BrowserWindow | null
): Promise<void> {
  const backendNodeId = opened.backendNodeId
  if (typeof backendNodeId !== 'number') return
  const request = await withDebugger((dbg) => chooserRequest(dbg, opened))
  let answer: FileChooserAnswer = ask
    ? await ask(request).catch((): FileChooserAnswer => ({ kind: 'cancel' }))
    : { kind: 'user' }
  if (answer.kind === 'user') answer = await systemChooser(parent(), request)
  const files = answer.kind === 'files' ? await uploadPaths(answer.files) : []
  await withDebugger(async (dbg) => {
    if (files.length) {
      await dbg.sendCommand('DOM.setFileInputFiles', { files, backendNodeId })
      return
    }
    const resolved = (await dbg.sendCommand('DOM.resolveNode', { backendNodeId })) as {
      object?: { objectId?: string }
    }
    const objectId = resolved.object?.objectId
    if (!objectId) return
    await dbg.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function () { this.dispatchEvent(new Event("cancel", { bubbles: true })) }'
    })
    await dbg.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined)
  })
}

/**
 * The element `selector` names in the top document or a same-origin frame inside it, its mark
 * taken off on the way (`markUpload` put it there). Runs in the page's main world.
 */
function findMarkedInput(selector: string): string {
  return `(() => {
  const sel = ${JSON.stringify(selector)}
  const visit = (doc) => {
    const el = doc.querySelector(sel)
    if (el) return el
    for (const f of doc.querySelectorAll('iframe, frame')) {
      try {
        const inner = f.contentDocument
        const found = inner && visit(inner)
        if (found) return found
      } catch {}
    }
    return null
  }
  const el = visit(document)
  if (el) el.removeAttribute('data-zen-upload')
  return el
})()`
}

/** Set the files of the marked `<input type=file>` without a chooser. */
export async function setInputFiles(
  dbg: Debugger,
  selector: string,
  files: readonly AgentUploadFile[]
): Promise<void> {
  const paths = await uploadPaths(files)
  const found = (await dbg.sendCommand('Runtime.evaluate', {
    expression: findMarkedInput(selector),
    returnByValue: false
  })) as { result?: { objectId?: string; subtype?: string } }
  const objectId = found.result?.objectId
  if (!objectId || found.result?.subtype === 'null')
    throw new Error('the input is not in this document or a frame of the same site')
  try {
    await dbg.sendCommand('DOM.setFileInputFiles', { files: paths, objectId })
  } finally {
    await dbg.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

/** Drag files from outside onto the page at a viewport point and drop them there. */
export async function dropFiles(
  dbg: Debugger,
  x: number,
  y: number,
  files: readonly AgentUploadFile[]
): Promise<void> {
  const paths = await uploadPaths(files)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
    await dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data })
}
