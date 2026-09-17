import { JsonStore } from './store/JsonStore'
import type { DialogHost, StoreIO } from './platform'

export type PermissionDecision = 'allow' | 'deny'
type Decision = PermissionDecision

interface Persisted {
  version: 1
  decisions: Record<string, Decision>
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

const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'window-management',
  'speaker-selection',
  'fileSystem',
  'idle-detection',
  'storage-access',
  'top-level-storage-access',
  'background-sync'
])
const ALWAYS_DENY = new Set(['midiSysex', 'hid', 'serial', 'usb', 'display-capture', 'unknown'])
const PROMPT_LABELS: Record<string, string> = {
  media: 'use your camera and/or microphone',
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'send you notifications',
  midi: 'access MIDI devices',
  openExternal: 'open an external application',
  'clipboard-read': 'read from your clipboard',
  mediaKeySystem: 'play protected (DRM) content'
}

/**
 * Chromium-style permission prompts with per-origin persistence. Zen (Firefox) asks the user for
 * camera/microphone/location/notifications; everything exotic is denied by default.
 *
 * `permissions.json` is also the store of record for content settings the user sets without a
 * prompt (ad and tracker blocking per site, and its default): the same `origin|permission` keys,
 * so the site-information sheet lists and resets them like any other decision.
 */
export class PermissionService {
  private decisions: Record<string, Decision> = {}
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
  check(permission: string, requestingOrigin: string): boolean {
    if (ALWAYS_ALLOW.has(permission)) return true
    if (ALWAYS_DENY.has(permission)) return false
    const origin = safeOrigin(requestingOrigin)
    return (this.decisions[`${origin}|${permission}`] ?? this.defaultFor(permission)) === 'allow'
  }

  /** Decide a permission request, prompting the user once per origin+permission. */
  async decide(permission: string, requestingUrl: string): Promise<boolean> {
    if (ALWAYS_ALLOW.has(permission)) return true
    if (ALWAYS_DENY.has(permission)) return false
    const origin = safeOrigin(requestingUrl)
    if (!origin || origin === 'null') return false
    const key = `${origin}|${permission}`
    const stored = this.decisions[key] ?? this.defaultFor(permission)
    if (stored) return stored === 'allow'
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const promise = this.prompt(permission, origin, key)
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      this.pending.delete(key)
    }
  }

  private async prompt(permission: string, origin: string, key: string): Promise<boolean> {
    const label = PROMPT_LABELS[permission] ?? `use "${permission}"`
    const allowed = await this.dialogs.confirm({
      message: `Allow ${origin} to ${label}?`,
      detail: 'Your choice is remembered for this site.',
      okLabel: 'Allow',
      cancelLabel: 'Block'
    })
    this.update(key, allowed ? 'allow' : 'deny', { permission, origin })
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
  listForOrigin(requestingOrigin: string): Array<{ permission: string; decision: Decision }> {
    const origin = safeOrigin(requestingOrigin)
    if (!origin) return []
    const out: Array<{ permission: string; decision: Decision }> = []
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

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
