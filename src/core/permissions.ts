import { JsonStore } from './store/JsonStore'
import type { DialogHost, StoreIO } from './platform'
import type { PermissionRule } from '../shared/types'

export type PermissionDecision = PermissionRule['decision']
type Decision = PermissionDecision

interface Persisted {
  version: 1
  decisions: Record<string, PermissionDecision>
}

/** A decision changed: `origin` is null when it was a permission's default. */
export interface PermissionChange {
  permission: string
  origin: string | null
}

/**
 * The "origin" of a permission's default decision (Chrome's content-setting default). Never a real
 * origin, so `listForOrigin` and `resetOrigin` cannot reach it.
 */
const DEFAULT_ORIGIN = '*'

/** Facts about one request that shape the prompt, or the key the answer is remembered under. */
export interface PermissionRequestDetails {
  /** Top-level page the request happens in, when the requesting frame is embedded in another site. */
  embedderUrl?: string
  /** `openExternal`: the URL that would be handed to another application. */
  externalUrl?: string
  /** `openExternal`: the application that would receive it, when the host knows. */
  targetApp?: string
  /** `fileSystem`: the file or directory the page wants and how it wants it. */
  filePath?: string
  isDirectory?: boolean
  fileAccessType?: 'writable' | 'readable'
}

export interface PermissionPromptCopy {
  message: string
  detail: string
  okLabel: string
  cancelLabel: string
}

/**
 * Pages get these without asking: they are either harmless or already gated by the engine on a
 * user gesture (fullscreen, pointer lock, keyboard lock, sanitised clipboard writes).
 */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'speaker-selection',
  'background-sync'
])
const ALWAYS_DENY = new Set(['midiSysex', 'hid', 'serial', 'usb', 'display-capture', 'unknown'])

/** Permissions the user is asked about; a blocked pop-up is never a question, only a stored allow. */
const PROMPT_LABELS: Record<string, string> = {
  media: 'use your camera and/or microphone',
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'send you notifications',
  midi: 'access MIDI devices',
  'clipboard-read': 'read from your clipboard',
  mediaKeySystem: 'play protected (DRM) content',
  'window-management': 'manage windows on all your displays',
  'idle-detection': 'know when you are actively using this device',
  'top-level-storage-access': 'let the sites embedded in it use their cookies and site data'
}

/**
 * A "Block" for these is a one-time answer: the site can ask again. Refusing to hand a link to
 * another application once should not silence that application on the site for good.
 */
const ONE_SHOT_DENY = new Set(['openExternal'])

/** Longest URL or path shown inside a prompt. */
const MAX_SHOWN = 80

/**
 * Chromium-style permission prompts with per-origin persistence. Zen (Firefox) asks the user for
 * camera/microphone/location/notifications; everything exotic is denied by default.
 *
 * Keys are `${origin}|${permission}` where the permission may carry a qualifier after a colon
 * (`openExternal:zoommtg`, `storage-access:https://embedder.example`), so one answer never covers
 * a different scheme or a different embedding site.
 *
 * `permissions.json` is also the store of record for content settings the user sets without a
 * prompt (ad and tracker blocking per site, and its default): the same `origin|permission` keys,
 * so the site-information sheet lists and resets them like any other decision.
 */
export class PermissionService {
  private decisions: Record<string, PermissionDecision> = {}
  private readonly store: JsonStore<Persisted>
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly listeners = new Set<(change: PermissionChange) => void>()

  constructor(
    io: StoreIO,
    private readonly dialogs: DialogHost
  ) {
    this.store = new JsonStore<Persisted>(io, 'permissions.json', 500)
    const data = this.store.readSync()
    if (data?.version === 1 && data.decisions) this.decisions = data.decisions
  }

  /** Synchronous check (e.g. `Notification.permission`); never prompts, unknown → false. */
  check(permission: string, requestingOrigin: string, details?: PermissionRequestDetails): boolean {
    if (ALWAYS_ALLOW.has(permission)) return true
    if (ALWAYS_DENY.has(permission)) return false
    return this.stored(permission, requestingOrigin, details) === 'allow'
  }

  /**
   * The remembered answer for origin + permission (or the permission's default, see `defaultFor`),
   * or null when the site would be asked.
   */
  stored(
    permission: string,
    requestingUrl: string,
    details?: PermissionRequestDetails
  ): PermissionDecision | null {
    const origin = safeOrigin(requestingUrl)
    if (!origin || origin === 'null') return null
    return (
      this.decisions[decisionKey(origin, permission, details)] ??
      this.defaultFor(permission) ??
      null
    )
  }

  /** Remember an answer without prompting ("Always allow pop-ups on this site"). */
  remember(
    permission: string,
    requestingUrl: string,
    decision: PermissionDecision,
    details?: PermissionRequestDetails
  ): void {
    const origin = safeOrigin(requestingUrl)
    if (!origin || origin === 'null') return
    const key = decisionKey(origin, permission, details)
    this.update(key, decision, changeFor(key))
  }

  /** Forget one origin's answer for a permission: the site is asked (or blocked) again. */
  forget(permission: string, requestingUrl: string, details?: PermissionRequestDetails): void {
    const origin = safeOrigin(requestingUrl)
    if (!origin) return
    const key = decisionKey(origin, permission, details)
    this.update(key, null, changeFor(key))
  }

  /** Every remembered per-site answer (Settings lists and revokes them); defaults are not sites. */
  rules(): PermissionRule[] {
    const out: PermissionRule[] = []
    for (const [key, decision] of Object.entries(this.decisions)) {
      const split = key.lastIndexOf('|')
      if (split < 0) continue
      const origin = key.slice(0, split)
      if (origin === DEFAULT_ORIGIN) continue
      out.push({ origin, permission: key.slice(split + 1), decision })
    }
    return out.sort(
      (a, b) => a.permission.localeCompare(b.permission) || a.origin.localeCompare(b.origin)
    )
  }

  /** Forget one rule as Settings lists it (`permission` is the stored, qualified name). */
  forgetRule(origin: string, permission: string): void {
    const key = `${origin}|${permission}`
    this.update(key, null, changeFor(key))
  }

  /** Decide a permission request, prompting the user once per origin + permission. */
  async decide(
    permission: string,
    requestingUrl: string,
    details: PermissionRequestDetails = {}
  ): Promise<boolean> {
    if (ALWAYS_ALLOW.has(permission)) return true
    if (ALWAYS_DENY.has(permission)) return false
    // Pop-ups are decided by the blocker from the user's gesture; there is nothing to ask.
    if (permission === 'popups') return this.stored(permission, requestingUrl) === 'allow'
    const origin = safeOrigin(requestingUrl)
    if (!origin || origin === 'null') return false
    const key = decisionKey(origin, permission, details)
    const stored = this.decisions[key] ?? this.defaultFor(permission)
    if (stored) return stored === 'allow'
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const promise = this.prompt(permission, origin, key, details)
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      this.pending.delete(key)
    }
  }

  private async prompt(
    permission: string,
    origin: string,
    key: string,
    details: PermissionRequestDetails
  ): Promise<boolean> {
    const allowed = await this.dialogs.confirm(permissionPromptCopy(permission, origin, details))
    if (allowed || !ONE_SHOT_DENY.has(permission))
      this.update(key, allowed ? 'allow' : 'deny', changeFor(key))
    return allowed
  }

  reset(): void {
    const keys = Object.keys(this.decisions)
    this.decisions = {}
    this.store.write({ version: 1, decisions: this.decisions })
    for (const key of keys) this.notify(changeFor(key))
  }

  // ---------------------------------------------------------------------------
  // Content settings: decisions made in Settings or the site-information sheet, no prompt
  // ---------------------------------------------------------------------------

  /** The decision stored for an origin and permission (no default, no prompt). */
  get(permission: string, requestingOrigin: string): Decision | undefined {
    const origin = safeOrigin(requestingOrigin)
    return origin ? this.decisions[`${origin}|${permission}`] : undefined
  }

  /** Remember a decision for an origin, or forget it with `null`. */
  set(permission: string, requestingOrigin: string, decision: Decision | null): void {
    const origin = safeOrigin(requestingOrigin)
    if (!origin || origin === 'null') return
    this.update(`${origin}|${permission}`, decision, { permission, origin })
  }

  /** A permission's default for origins without a decision of their own (`undefined`: none set). */
  defaultFor(permission: string): Decision | undefined {
    return this.decisions[`${DEFAULT_ORIGIN}|${permission}`]
  }

  setDefault(permission: string, decision: Decision | null): void {
    this.update(`${DEFAULT_ORIGIN}|${permission}`, decision, { permission, origin: null })
  }

  /** Every origin with its own decision for `permission` (the exception lists in Settings). */
  listForPermission(permission: string): Array<{ origin: string; decision: Decision }> {
    const suffix = `|${permission}`
    const out: Array<{ origin: string; decision: Decision }> = []
    for (const [key, decision] of Object.entries(this.decisions)) {
      if (!key.endsWith(suffix)) continue
      const origin = key.slice(0, -suffix.length)
      if (origin && origin !== DEFAULT_ORIGIN && !origin.includes('|'))
        out.push({ origin, decision })
    }
    return out.sort((a, b) => a.origin.localeCompare(b.origin))
  }

  /** Called after any decision changes (prompt, set, reset); returns the unsubscribe function. */
  subscribe(listener: (change: PermissionChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(key: string, decision: Decision | null, change: PermissionChange): void {
    if ((this.decisions[key] ?? null) === decision) return
    if (decision === null) delete this.decisions[key]
    else this.decisions[key] = decision
    this.store.write({ version: 1, decisions: this.decisions })
    this.notify(change)
  }

  private notify(change: PermissionChange): void {
    for (const listener of [...this.listeners]) listener(change)
  }

  /** Every remembered decision for an origin (the site-information sheet lists these). */
  listForOrigin(
    requestingOrigin: string
  ): Array<{ permission: string; decision: PermissionDecision }> {
    const origin = safeOrigin(requestingOrigin)
    if (!origin) return []
    const out: Array<{ permission: string; decision: PermissionDecision }> = []
    for (const [key, decision] of Object.entries(this.decisions)) {
      const split = key.lastIndexOf('|')
      if (split < 0 || key.slice(0, split) !== origin) continue
      out.push({ permission: key.slice(split + 1), decision })
    }
    return out.sort((a, b) => a.permission.localeCompare(b.permission))
  }

  /** Forget the decisions of an origin (one permission, or all of them): the site asks again. */
  resetOrigin(requestingOrigin: string, permission?: string): void {
    const origin = safeOrigin(requestingOrigin)
    if (!origin) return
    const removed: string[] = []
    for (const key of Object.keys(this.decisions)) {
      const split = key.lastIndexOf('|')
      if (split < 0 || key.slice(0, split) !== origin) continue
      if (permission !== undefined && key.slice(split + 1) !== permission) continue
      delete this.decisions[key]
      removed.push(key)
    }
    if (removed.length === 0) return
    this.store.write({ version: 1, decisions: this.decisions })
    for (const key of removed) this.notify(changeFor(key))
  }
}

function changeFor(key: string): PermissionChange {
  const split = key.lastIndexOf('|')
  const origin = key.slice(0, split)
  return { permission: key.slice(split + 1), origin: origin === DEFAULT_ORIGIN ? null : origin }
}

/** The stored key for a request; qualifiers keep unrelated answers apart. */
export function decisionKey(
  origin: string,
  permission: string,
  details?: PermissionRequestDetails
): string {
  return `${origin}|${qualifiedPermission(permission, details)}`
}

export function qualifiedPermission(
  permission: string,
  details?: PermissionRequestDetails
): string {
  if (permission === 'openExternal') {
    const target = externalTarget(details?.externalUrl ?? '')
    if (target.scheme !== 'intent')
      return target.scheme ? `openExternal:${target.scheme}` : permission
    return target.app ? `openExternal:package:${target.app}` : 'openExternal:intent'
  }
  if (permission === 'storage-access') {
    const embedder = safeOrigin(details?.embedderUrl ?? '')
    return embedder && embedder !== 'null' ? `storage-access:${embedder}` : permission
  }
  return permission
}

/**
 * What an external link really targets. An Android `intent:` URL is only a wrapper: its
 * fragment (`#Intent;scheme=zxing;package=com.example.scanner;end`) names the link scheme the
 * app handles and the app itself, and those are what the user hears about and what a remembered
 * answer covers (the same as a plain `zxing:` link would).
 */
export function externalTarget(url: string): { scheme: string; app: string | null } {
  const scheme = schemeOf(url)
  if (scheme !== 'intent') return { scheme, app: null }
  const hash = url.indexOf('#')
  const fields = hash === -1 ? [] : url.slice(hash + 1).split(';')
  const field = (name: string): string | null => {
    const hit = fields.find((f) => f.startsWith(`${name}=`))
    const value = hit ? hit.slice(name.length + 1).trim() : ''
    return value ? value : null
  }
  const inner = field('scheme')?.toLowerCase() ?? ''
  const app = field('package')
  return { scheme: /^[a-z][a-z0-9+.-]*$/.test(inner) ? inner : scheme, app }
}

/** The words of a permission prompt, shared by every host so the copy matches everywhere. */
export function permissionPromptCopy(
  permission: string,
  origin: string,
  details: PermissionRequestDetails = {}
): PermissionPromptCopy {
  const site = displayOrigin(origin)
  const remembered = 'Your choice is remembered for this site.'
  switch (permission) {
    case 'openExternal': {
      const { scheme, app } = externalTarget(details.externalUrl ?? '')
      const wrapped = scheme === 'intent'
      const what = details.targetApp
        ? details.targetApp
        : wrapped
          ? app
            ? `the app ${app}`
            : 'another app'
          : scheme
            ? `${scheme}: links in another app`
            : 'another app'
      const link = app
        ? `\nApp: ${shorten(app)}`
        : details.externalUrl
          ? `\n${shorten(details.externalUrl)}`
          : ''
      const scope = wrapped
        ? app
          ? `links to ${shorten(app)} on this site`
          : 'this site'
        : scheme
          ? `${scheme}: links on this site`
          : 'this site'
      return {
        message: `Allow ${site} to open ${what}?`,
        detail: `Zenium hands the link to an application outside the browser.${link}\nChoosing Open is remembered for ${scope}.`,
        okLabel: 'Open',
        cancelLabel: 'Cancel'
      }
    }
    case 'fileSystem': {
      const target = details.filePath
        ? `"${shorten(basename(details.filePath))}"`
        : details.isDirectory
          ? 'this folder'
          : 'this file'
      const message =
        details.fileAccessType === 'readable'
          ? `Allow ${site} to view ${details.isDirectory ? `the files in ${target}` : target}?`
          : `Allow ${site} to save changes to ${target}?`
      return {
        message,
        detail: `The site can ${details.fileAccessType === 'readable' ? 'read' : 'edit'} ${details.isDirectory ? 'everything in the folder' : 'the file'} until you take the permission away. ${remembered}`,
        okLabel: details.fileAccessType === 'readable' ? 'View files' : 'Save changes',
        cancelLabel: 'Block'
      }
    }
    case 'storage-access': {
      const embedder = safeOrigin(details.embedderUrl ?? '')
      const where =
        embedder && embedder !== 'null' ? ` while you are on ${displayOrigin(embedder)}` : ''
      return {
        message: `Allow ${site} to use cookies and site data it has stored${where}?`,
        detail: `${site} is embedded in the page and wants to see you as signed in there. ${remembered}`,
        okLabel: 'Allow',
        cancelLabel: 'Block'
      }
    }
    default: {
      const label = PROMPT_LABELS[permission] ?? `use "${permission}"`
      return {
        message: `Allow ${site} to ${label}?`,
        detail: remembered,
        okLabel: 'Allow',
        cancelLabel: 'Block'
      }
    }
  }
}

/** `https://example.com` → `example.com`; other schemes keep their prefix so they stay honest. */
export function displayOrigin(origin: string): string {
  return origin.replace(/^https:\/\//, '')
}

export function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())
  return m ? m[1].toLowerCase() : ''
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed
}

function shorten(text: string): string {
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
