import type {
  ClientCertificateInfo,
  DeviceCandidate,
  DeviceKind,
  HttpAuthPrompt,
  PermissionPrompt,
  PermissionPromptAnswer,
  ScreenCaptureSource
} from '../../shared/types'
import type { AgentUploadFile, FileChooserAnswer, FileChooserRequest } from '../platform'
import type { HttpCredentials } from '../security'
import { RpcError } from './jsonrpc'
import type { AgentPromptAnswer, AgentPromptSpec } from './prompts'

/**
 * What each kind of native prompt looks like to an agent (`AgentService.routePrompt`): its
 * summary, the details it answers from, the actions it takes and the value each gives the caller
 * that would otherwise have shown the user its UI. Nothing an agent answers is remembered for
 * the user – a permission is this tab's until it leaves the site, a sign-in or a certificate
 * goes with the one request – and silence is the refusal (a download, which goes where
 * Downloads puts it, aside).
 */
export type NativePromptSpec<T> = Omit<AgentPromptSpec<T>, 'ttlMs'>

/** The key `answerPrompt` sets on every answer: whether the agent's paths name this computer's files. */
export const ANSWER_FROM_THIS_COMPUTER = 'fromThisComputer'

/** At most this many bytes of files an agent sends inline (`base64`), per answer. */
export const MAX_INLINE_UPLOAD_BYTES = 50 * 1024 * 1024

function bad(message: string): never {
  throw new RpcError(-32602, message)
}

function text(answer: AgentPromptAnswer, key: string): string {
  const value = answer[key]
  if (typeof value !== 'string') bad(`"${answer.action}" needs ${JSON.stringify(key)} (a string)`)
  return value
}

/**
 * The files of an upload – `paths` on this computer, `files` sent inline – checked against what
 * the input takes. Paths only from an agent on this computer: another machine's paths would
 * name whatever this one has there.
 */
export function uploadFiles(
  args: Record<string, unknown>,
  opts: { local: boolean; mode: FileChooserRequest['mode'] }
): AgentUploadFile[] {
  const out: AgentUploadFile[] = []
  const paths = args.paths ?? (typeof args.path === 'string' ? [args.path] : undefined)
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.trim()))
      bad('"paths" is a list of file paths')
    if (!opts.local)
      bad(
        'You connect from another machine: paths on your machine mean nothing here. Send the file contents instead – "files": [{"name":"report.pdf","base64":"…"}].'
      )
    for (const p of paths as string[]) out.push({ path: p.trim() })
  }
  const files = args.files
  if (files !== undefined) {
    if (!Array.isArray(files)) bad('"files" is a list of {"name","base64","mimeType"?}')
    let bytes = 0
    for (const f of files as unknown[]) {
      const file = f as Record<string, unknown> | null
      if (!file || typeof file.name !== 'string' || typeof file.base64 !== 'string')
        bad('each of "files" needs "name" and "base64" (strings)')
      const name = file.name.trim()
      if (!name || /[\\/]/.test(name) || name === '.' || name === '..')
        bad(`${JSON.stringify(file.name)} is not a file name (no folders in it)`)
      bytes += Math.floor((file.base64.length * 3) / 4)
      out.push({
        name,
        base64: file.base64,
        ...(typeof file.mimeType === 'string' ? { mimeType: file.mimeType } : {})
      })
    }
    if (bytes > MAX_INLINE_UPLOAD_BYTES)
      bad(`Inline files are capped at ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB per upload`)
  }
  if (!out.length) bad('Name the files: "paths" (on this computer) or "files" (inline, base64)')
  if (opts.mode === 'folder') {
    if (out.length !== 1 || !('path' in out[0]))
      bad('This input takes a folder: send one folder path in "paths"')
  } else if (opts.mode === 'single' && out.length > 1)
    bad(`This input takes one file, not ${out.length}`)
  return out
}

/** A file chooser the page opened: hand it files, or cancel it. */
export function fileChooserSpec(
  tabId: string,
  request: FileChooserRequest
): NativePromptSpec<FileChooserAnswer> {
  const what =
    request.mode === 'folder' ? 'a folder' : request.mode === 'multiple' ? 'files' : 'a file'
  const accept = request.accept.length ? ` (it accepts ${request.accept.join(', ')})` : ''
  return {
    kind: 'file-chooser',
    tabId,
    summary: `The page opened a file chooser for ${what}${accept}.`,
    details: { mode: request.mode, accept: request.accept, source: request.source },
    actions: {
      upload:
        request.mode === 'folder'
          ? 'hand it a folder on this computer: {"paths":["/path/to/folder"]}'
          : `hand it ${request.mode === 'multiple' ? 'one or more files' : 'one file'}: {"paths":[…]} for files on this computer, or {"files":[{"name":"a.pdf","base64":"…","mimeType":"application/pdf"}]} from anywhere`,
      cancel: 'the page hears the chooser was cancelled'
    },
    defaultAction: 'cancel',
    dismissAction: 'cancel',
    decide: (answer) => {
      if (answer.action === 'cancel') return { kind: 'cancel' }
      const local = answer[ANSWER_FROM_THIS_COMPUTER] === true
      return { kind: 'files', files: uploadFiles(answer, { local, mode: request.mode }) }
    }
  }
}

/** Where a download the user's setting would ask about goes. */
export type DownloadDestination = { kind: 'save'; filename: string | null } | { kind: 'cancel' }

/** "Ask where to save each file" for a download of an agent's tab. */
export function downloadSpec(
  tabId: string,
  download: { url: string; filename: string; mimeType: string; totalBytes: number }
): NativePromptSpec<DownloadDestination> {
  const size = download.totalBytes > 0 ? `, ${download.totalBytes} bytes` : ''
  return {
    kind: 'download',
    tabId,
    summary: `The page is downloading ${JSON.stringify(download.filename)}${size}; the browser asks where to save it.`,
    details: { ...download },
    actions: {
      save: 'save it in the Downloads folder – as suggested, or under {"filename":"another-name.ext"} (a name, no folders)',
      cancel: 'the download is cancelled'
    },
    defaultAction: 'save',
    dismissAction: 'cancel',
    decide: (answer) => {
      if (answer.action === 'cancel') return { kind: 'cancel' }
      const raw = answer.filename
      if (raw === undefined || raw === null) return { kind: 'save', filename: null }
      if (typeof raw !== 'string') bad('"filename" is a string')
      const name = raw.trim()
      if (!name || /[\\/]/.test(name) || name === '.' || name === '..')
        bad(`${JSON.stringify(raw)} is not a file name: the file stays in the Downloads folder`)
      return { kind: 'save', filename: name }
    }
  }
}

/** HTTP authentication (Basic, Digest, NTLM, a proxy's): the request waits on it. */
export function httpAuthSpec(
  prompt: HttpAuthPrompt & { tabId: string }
): NativePromptSpec<HttpCredentials | null> {
  const where = `${prompt.host}${prompt.port && prompt.port !== 80 && prompt.port !== 443 ? `:${prompt.port}` : ''}`
  return {
    kind: 'http-auth',
    tabId: prompt.tabId,
    summary: `${prompt.isProxy ? 'The proxy' : where} asks to sign in${prompt.realm ? ` to ${JSON.stringify(prompt.realm)}` : ''}${prompt.secure ? '' : ' (over an unencrypted connection)'}${prompt.failedBefore ? '; the last credentials were refused' : ''}.`,
    details: {
      host: prompt.host,
      port: prompt.port,
      realm: prompt.realm,
      scheme: prompt.scheme,
      proxy: prompt.isProxy,
      secure: prompt.secure,
      failedBefore: prompt.failedBefore,
      ...(prompt.username ? { username: prompt.username } : {})
    },
    actions: {
      'sign-in': 'send {"username":…,"password":…} for this request only (nothing is remembered)',
      cancel: "give up: the page shows the server's refusal"
    },
    defaultAction: 'cancel',
    dismissAction: 'cancel',
    blocking: true,
    decide: (answer) =>
      answer.action === 'sign-in'
        ? { username: text(answer, 'username'), password: text(answer, 'password') }
        : null
  }
}

/** Which client certificate goes to a site that asks for one: the request waits on it. */
export function clientCertificateSpec(
  tabId: string,
  host: string,
  certificates: ClientCertificateInfo[]
): NativePromptSpec<number | null> {
  return {
    kind: 'client-certificate',
    tabId,
    summary: `${host} asks for a client certificate (${certificates.length} on offer).`,
    details: {
      host,
      certificates: certificates.map((c, index) => ({
        index,
        subject: c.subject,
        issuer: c.issuer,
        validTo: new Date(c.validTo).toISOString()
      }))
    },
    actions: {
      select: 'send the certificate {"index":n} for this request (not remembered)',
      none: 'continue without one'
    },
    defaultAction: 'none',
    dismissAction: 'none',
    blocking: true,
    decide: (answer) => {
      if (answer.action === 'none') return null
      const index = answer.index
      if (typeof index !== 'number' || !Number.isInteger(index) || !certificates[index])
        bad(`"select" needs "index", 0 to ${certificates.length - 1}`)
      return index
    }
  }
}

/**
 * A permission request (camera, microphone, location, notifications, clipboard, MIDI, an
 * external app on the desktop…). An allow is this tab's until it leaves the site ("Allow once");
 * a refusal is not remembered either – the site asks again next time.
 */
export function permissionSpec(
  prompt: PermissionPrompt & { tabId: string },
  opts: { externalUrl?: string } = {}
): NativePromptSpec<PermissionPromptAnswer | null> {
  const external = opts.externalUrl !== undefined
  return {
    kind: external ? 'external-protocol' : 'permission',
    tabId: prompt.tabId,
    summary: `${prompt.message}${prompt.detail ? ` ${prompt.detail}` : ''}`.trim(),
    details: {
      origin: prompt.origin,
      permission: prompt.permission,
      ...(external ? { url: opts.externalUrl } : {})
    },
    actions: {
      allow: external
        ? 'hand the link to the app on this computer'
        : 'grant it to this tab until it leaves the site (never remembered for the user)',
      deny: 'refuse it this once (nothing is remembered)'
    },
    defaultAction: 'deny',
    dismissAction: 'deny',
    decide: (answer) => (answer.action === 'allow' ? 'allow-once' : null)
  }
}

/** A link that leaves the browser for an app (Android's `ExternalProtocolService`). */
export function externalProtocolSpec(
  tabId: string,
  request: { url: string; scheme: string; appName: string | null; site: string }
): NativePromptSpec<boolean> {
  return {
    kind: 'external-protocol',
    tabId,
    summary: `${request.site || 'The page'} wants to open ${request.appName ? JSON.stringify(request.appName) : `a ${request.scheme}: link in another app`}.`,
    details: { ...request },
    actions: {
      allow: 'open the link in the app, this once',
      deny: 'stay in the browser'
    },
    defaultAction: 'deny',
    dismissAction: 'deny',
    decide: (answer) => answer.action === 'allow'
  }
}

/** A page's `getDisplayMedia`: agents are offered their own tabs, never the user's screen or windows. */
export function screenCaptureSpec(
  tabId: string,
  origin: string,
  sources: ScreenCaptureSource[]
): NativePromptSpec<string | null> {
  return {
    kind: 'screen-capture',
    tabId,
    summary: `${origin || 'The page'} asks to capture a tab (screen sharing).`,
    details: {
      origin,
      sources: sources.map((s) => ({ id: s.id, name: s.name })),
      note: "Only your own tabs are offered: the user's screen and windows never are."
    },
    actions: {
      share: 'share one of the sources: {"sourceId":"tab:…"}',
      cancel: 'refuse: the page hears the picker was cancelled'
    },
    defaultAction: 'cancel',
    dismissAction: 'cancel',
    decide: (answer) => {
      if (answer.action === 'cancel') return null
      const id = text(answer, 'sourceId')
      if (!sources.some((s) => s.id === id))
        bad(`${JSON.stringify(id)} is not on offer: ${sources.map((s) => s.id).join(', ')}`)
      return id
    }
  }
}

/** A Web Bluetooth / USB / Serial / HID chooser; its list may fill in while the engine scans. */
export function deviceChooserSpec(
  tabId: string,
  kind: DeviceKind,
  origin: string,
  current: () => DeviceCandidate[]
): NativePromptSpec<string | null> {
  return {
    kind: 'device-chooser',
    tabId,
    summary: `${origin} asks to connect to a ${kind === 'hid' ? 'HID' : kind === 'usb' ? 'USB' : kind} device.`,
    details: { origin, device: kind, candidates: current() },
    actions: {
      connect:
        'give the site the device {"deviceId":…} while this tab is yours (never saved for the user) – browser_prompts shows the list as it fills in',
      cancel: 'refuse'
    },
    defaultAction: 'cancel',
    dismissAction: 'cancel',
    decide: (answer) => {
      if (answer.action === 'cancel') return null
      const id = text(answer, 'deviceId')
      if (!current().some((c) => c.id === id)) bad(`No device ${JSON.stringify(id)} is on the list`)
      return id
    }
  }
}
