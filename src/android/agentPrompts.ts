import type { DownloadDestination } from '@core/agent/nativePrompts'
import type { AgentUploadFile, FileChooserAnswer, FileChooserRequest } from '@core/platform'
import type { ClientCertificateInfo } from '@shared/types'

/**
 * The Android side of an AI agent's native prompts (`TabView.interceptAgentPrompts`, PR #745's
 * `agentPrompts` capability): the shapes Kotlin's events carry and the answers that go back,
 * kept pure so the decisions are tested without a bridge. While an agent works a page, Kotlin
 * holds the WebView's file chooser, the KeyChain's client-certificate chooser and the save
 * dialog of a download instead of showing them, asks the core whose they are, and shows its own
 * UI only for a tab that turns out not to be an agent's. Nothing an agent answers is remembered
 * for the user (`Security.kt` keeps the agent's certificate pick out of its per-host memory);
 * the two-minute default is the core's (`AgentPromptQueue`), and takes each kind's cancel.
 */

/** What Kotlin's `fileChooser` view event carries of `WebChromeClient.FileChooserParams`. */
export interface FileChooserEvent {
  requestId: string
  /** `MODE_OPEN_MULTIPLE`; the WebView has no folder mode (`webkitdirectory` is not supported). */
  multiple?: boolean
  accept?: unknown
}

/** The core's `FileChooserRequest` for a chooser the WebView opened. */
export function fileChooserRequestOf(event: FileChooserEvent): FileChooserRequest {
  const accept = Array.isArray(event.accept)
    ? event.accept
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter(Boolean)
    : []
  return { mode: event.multiple === true ? 'multiple' : 'single', accept, source: 'input' }
}

/**
 * One file of a chooser's answer as Kotlin takes it: bytes to write, never a path. A path the
 * agent names would be read by the WebView under Zenium's own uid – the app's cookies, its
 * preferences, the agent token store – and handed to whatever page the agent drives, which no
 * agent may do; the agent sends the file's contents instead, as `setInputFiles` has it.
 */
export type WireUploadFile = { name: string; mimeType: string | null; base64: string }

/** The `view.fileChooserAnswer` command's payload (without the tab and request ids). */
export type FileChooserAnswerWire =
  { kind: 'files'; files: WireUploadFile[] } | { kind: 'cancel' } | { kind: 'user' }

/**
 * The core's answer as the bridge carries it to Kotlin. An answer that names a path on this
 * device is refused whole: the chooser is cancelled and the agent hears why
 * (`uploadPathsRefusal`); nothing of it reaches Kotlin, which takes no paths either.
 */
export function fileChooserAnswerWire(answer: FileChooserAnswer): FileChooserAnswerWire {
  if (answer.kind !== 'files') return { kind: answer.kind }
  if (uploadPathsRefusal(answer.files)) return { kind: 'cancel' }
  return {
    kind: 'files',
    files: answer.files
      .filter((f): f is Exclude<AgentUploadFile, { path: string }> => !('path' in f))
      .map((f) => ({ name: f.name, mimeType: f.mimeType ?? null, base64: f.base64 }))
  }
}

/**
 * Why an upload's files are refused on this device, or null when none of them is a path: the
 * one sentence the chooser's notice and `setInputFiles`' error both say, so the agent is told
 * the same thing whichever way it sent them.
 */
export function uploadPathsRefusal(files: readonly AgentUploadFile[]): string | null {
  const paths = files.filter((f): f is { path: string } => 'path' in f)
  if (!paths.length) return null
  return `paths cannot be read on this device (${paths.map((p) => p.path).join(', ')}); send the file contents instead ("files": [{"name","base64","mimeType"}])`
}

/**
 * The notice an agent reads when its answer to a page's file chooser named paths: the chooser
 * was cancelled for the page, and the same answer with the bytes is the way through.
 */
export function fileChooserPathsNotice(tabId: string, refusal: string): string {
  return `Notice: your answer to the file chooser in tab ${tabId} was refused and the page heard the chooser was cancelled: ${refusal}.`
}

/** What Kotlin's `certificate.request` host event carries of a `ClientCertRequest`. */
export interface ClientCertificateEvent {
  requestId: string
  tabId: string
  host: string
  port?: number
  /** The certificates on offer, in the order Kotlin's aliases answer by. */
  certificates?: unknown
}

/**
 * The certificates of a client-certificate request as the core's chooser describes them
 * (`ClientCertificateInfo`); an entry Kotlin could not describe is dropped, so the indexes the
 * core answers with are Kotlin's.
 */
export function clientCertificatesOf(event: ClientCertificateEvent): ClientCertificateInfo[] {
  if (!Array.isArray(event.certificates)) return []
  const out: ClientCertificateInfo[] = []
  for (const entry of event.certificates) {
    if (typeof entry !== 'object' || entry === null) continue
    const c = entry as Partial<Record<keyof ClientCertificateInfo, unknown>>
    if (typeof c.fingerprint !== 'string' || typeof c.subject !== 'string') continue
    out.push({
      fingerprint: c.fingerprint,
      subject: c.subject,
      issuer: typeof c.issuer === 'string' ? c.issuer : '',
      serialNumber: typeof c.serialNumber === 'string' ? c.serialNumber : '',
      validFrom: typeof c.validFrom === 'number' ? c.validFrom : 0,
      validTo: typeof c.validTo === 'number' ? c.validTo : 0
    })
  }
  return out
}

/** The `download.bind` destination as Kotlin reads it (`Downloads.bind`). */
export interface DownloadBindDestination {
  mode: 'ask' | 'folder' | 'default'
  folder?: string
  /**
   * The agent driving the tab answered where the save dialog would have asked: no dialog, the
   * file goes where the setting's folder (or the default) puts it, under the agent's name when
   * it gave one. Kotlin keeps that name against the response's own suggestion.
   */
  agent?: { filename: string | null }
}

/**
 * Where a download goes once the agent of its tab answered the ask-where-to-save question
 * (`AgentService.downloadDestination`): the setting's folder or the default, never the dialog,
 * or null for a cancel – the transfer is refused before a byte moves, and no record stays.
 */
export function agentDownloadDestination(
  answer: DownloadDestination,
  directory: string | null
): DownloadBindDestination | null {
  if (answer.kind === 'cancel') return null
  return {
    ...(directory ? { mode: 'folder', folder: directory } : { mode: 'default' }),
    agent: { filename: answer.filename }
  }
}

/**
 * Whether the host's save dialog would open for this download: the user's setting, or the one
 * download the menu's Save Link As… / Save Image As… started (`saveAs`, HB-40). Only then is
 * there a question for the tab's agent.
 */
export function downloadAsksWhere(settings: { askWhereToSave: boolean }, saveAs: boolean): boolean {
  return settings.askWhereToSave || saveAs
}

/**
 * The script that sets the files of the marked `<input type=file>` (`TabView.setInputFiles`):
 * the files are built in the page from the bytes the agent sent, so `input` and `change` fire
 * as a person's pick would. A path on this device cannot be read by page script (and the
 * app's own reach into another app's files is nil under scoped storage): the agent is told to
 * send the bytes. The input is told by tag and type, not `instanceof HTMLInputElement`: one
 * found in a same-origin frame belongs to that frame's realm, whose constructors are its own.
 * The result is `{ ok: true }` or `{ error }`.
 */
export function setInputFilesScript(selector: string, files: readonly AgentUploadFile[]): string {
  const error = uploadPathsRefusal(files)
  if (error) return `(${JSON.stringify({ error })})`
  const inline = files.filter(
    (f): f is Exclude<AgentUploadFile, { path: string }> => !('path' in f)
  )
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const files = ${JSON.stringify(inline.map((f) => ({ name: f.name, type: f.mimeType ?? '', base64: f.base64 })))};
  const find = (doc) => {
    const el = doc.querySelector(selector);
    if (el) return el;
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      try {
        const inner = frame.contentDocument;
        const found = inner && find(inner);
        if (found) return found;
      } catch {}
    }
    return null;
  };
  const input = find(document);
  if (!input) return { error: 'the input is not in this document or a frame of the same site' };
  input.removeAttribute('data-zen-upload');
  if (input.tagName !== 'INPUT' || input.type !== 'file') return { error: 'not a file input' };
  const transfer = new DataTransfer();
  for (const f of files) {
    const text = atob(f.base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    transfer.items.add(new File([bytes], f.name, { type: f.type }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`
}
