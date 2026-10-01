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

/**
 * File choosers come to the session instead of the system's dialog. `Page.fileChooserOpened`
 * reaches a session only with its Page domain enabled (measured on Electron 44), and only from
 * the frames that session is the DevTools target of: a cross-site frame runs in a process of
 * its own and is a target of its own (`armFrameChoosers`).
 */
export const INTERCEPT_FILE_CHOOSERS = [
  { method: 'Page.enable', params: {} },
  { method: 'Page.setInterceptFileChooserDialog', params: { enabled: true } }
] as const

/**
 * Every cross-site frame of the page attaches to the session as it starts, paused until it is
 * armed, so no script of its can open a chooser before its interception is on.
 */
export const ATTACH_FRAMES = {
  method: 'Target.setAutoAttach',
  params: {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }]
  }
} as const

export const DETACH_FRAMES = {
  method: 'Target.setAutoAttach',
  params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }
} as const

/** `Target.attachedToTarget`'s parameters. */
export interface FrameAttached {
  sessionId?: string
  targetInfo?: { type?: string }
  waitingForDebugger?: boolean
}

/**
 * A cross-site frame attached to the page's session (`ATTACH_FRAMES`): intercept its choosers
 * and attach its own cross-site frames, then let it run. It runs whatever happens – a frame left
 * paused would hang the page.
 */
export async function armFrameChoosers(dbg: Debugger, attached: FrameAttached): Promise<void> {
  const sessionId = attached.sessionId
  if (!sessionId) return
  try {
    if (attached.targetInfo?.type === 'iframe') {
      for (const command of [...INTERCEPT_FILE_CHOOSERS, ATTACH_FRAMES])
        await dbg.sendCommand(command.method, command.params, sessionId)
    }
  } finally {
    if (attached.waitingForDebugger !== false)
      await dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
  }
}

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
  opened: FileChooserOpened,
  sessionId?: string
): Promise<FileChooserRequest> {
  let accept: string[] = []
  let folder = false
  let picker = false
  try {
    const described = (await dbg.sendCommand(
      'DOM.describeNode',
      { backendNodeId: opened.backendNodeId },
      sessionId
    )) as { node?: { attributes?: string[] } }
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

/** The extensions the system's dialog filters by for the MIME types pages accept most. */
const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif'],
  'audio/*': ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba'],
  'video/*': ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi'],
  'text/*': ['txt', 'csv', 'tsv', 'html', 'htm', 'css', 'md', 'xml', 'ics', 'vtt'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/svg+xml': ['svg'],
  'application/pdf': ['pdf'],
  'application/json': ['json'],
  'application/zip': ['zip'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/html': ['html', 'htm'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx']
}

/**
 * The system dialog's extension filter for an `accept` list: `.ext` entries as they are, MIME
 * types through `MIME_EXTENSIONS`. Null when any entry has no known extensions (the dialog then
 * shows every file rather than hide what the page takes).
 */
export function acceptExtensions(accept: readonly string[]): string[] | null {
  if (!accept.length) return null
  const out = new Set<string>()
  for (const entry of accept) {
    const a = entry.toLowerCase()
    const known = a.startsWith('.') ? [a.slice(1)].filter(Boolean) : MIME_EXTENSIONS[a]
    if (!known?.length) return null
    for (const ext of known) out.add(ext)
  }
  return [...out]
}

/** The system's chooser, for a page that intercepts but is not an agent's (any more). */
async function systemChooser(
  parent: BrowserWindow | null,
  request: FileChooserRequest
): Promise<FileChooserAnswer> {
  const extensions = acceptExtensions(request.accept)
  const options: Electron.OpenDialogOptions = {
    properties:
      request.mode === 'folder'
        ? ['openDirectory']
        : request.mode === 'multiple'
          ? ['openFile', 'multiSelections']
          : ['openFile'],
    ...(extensions ? { filters: [{ name: 'Files', extensions }] } : {})
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
 * cancelled. `withDebugger` holds the page's session for the commands; `sessionId` names the
 * cross-site frame's session the chooser came from (its node ids are that session's).
 */
export async function answerFileChooser(
  withDebugger: <T>(fn: (dbg: Debugger) => Promise<T>) => Promise<T>,
  opened: FileChooserOpened,
  ask: ((request: FileChooserRequest) => Promise<FileChooserAnswer>) | undefined,
  parent: () => BrowserWindow | null,
  sessionId?: string
): Promise<void> {
  const backendNodeId = opened.backendNodeId
  if (typeof backendNodeId !== 'number') return
  const request = await withDebugger((dbg) => chooserRequest(dbg, opened, sessionId))
  let answer: FileChooserAnswer = ask
    ? await ask(request).catch((): FileChooserAnswer => ({ kind: 'cancel' }))
    : { kind: 'user' }
  if (answer.kind === 'user') answer = await systemChooser(parent(), request)
  const files = answer.kind === 'files' ? await uploadPaths(answer.files) : []
  await withDebugger(async (dbg) => {
    if (files.length) {
      await dbg.sendCommand('DOM.setFileInputFiles', { files, backendNodeId }, sessionId)
      return
    }
    const resolved = (await dbg.sendCommand('DOM.resolveNode', { backendNodeId }, sessionId)) as {
      object?: { objectId?: string }
    }
    const objectId = resolved.object?.objectId
    if (!objectId) return
    await dbg.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          'function () { this.dispatchEvent(new Event("cancel", { bubbles: true })) }'
      },
      sessionId
    )
    await dbg.sendCommand('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined)
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
