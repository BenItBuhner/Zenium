import { dialog, type BrowserWindow, type Session } from 'electron'
import { join } from 'node:path'
import { JsonStore } from '../store/JsonStore'

type Decision = 'allow' | 'deny'

interface Persisted {
  version: 1
  decisions: Record<string, Decision>
}

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
 */
export class PermissionService {
  private decisions: Record<string, Decision> = {}
  private readonly store: JsonStore<Persisted>
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(
    userDataDir: string,
    private readonly getWindow: () => BrowserWindow | null
  ) {
    this.store = new JsonStore<Persisted>(join(userDataDir, 'zen', 'permissions.json'), 500)
    const data = this.store.readSync()
    if (data?.version === 1 && data.decisions) this.decisions = data.decisions
  }

  attach(ses: Session): void {
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = safeOrigin(details.requestingUrl || webContents?.getURL() || '')
      void this.decide(permission, origin).then(callback)
    })
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (ALWAYS_ALLOW.has(permission)) return true
      if (ALWAYS_DENY.has(permission)) return false
      const origin = safeOrigin(requestingOrigin)
      const stored = this.decisions[`${origin}|${permission}`]
      // Checks (e.g. Notification.permission) must not prompt; unknown → false ("prompt").
      return stored === 'allow'
    })
  }

  private async decide(permission: string, origin: string): Promise<boolean> {
    if (ALWAYS_ALLOW.has(permission)) return true
    if (ALWAYS_DENY.has(permission)) return false
    if (!origin || origin === 'null') return false
    const key = `${origin}|${permission}`
    const stored = this.decisions[key]
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
    const win = this.getWindow()
    const label = PROMPT_LABELS[permission] ?? `use "${permission}"`
    const options = {
      type: 'question' as const,
      buttons: ['Allow', 'Block'],
      defaultId: 0,
      cancelId: 1,
      message: `Allow ${origin} to ${label}?`,
      detail: 'Your choice is remembered for this site.',
      noLink: true
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    const allowed = result.response === 0
    this.decisions[key] = allowed ? 'allow' : 'deny'
    this.store.write({ version: 1, decisions: this.decisions })
    return allowed
  }

  reset(): void {
    this.decisions = {}
    this.store.write({ version: 1, decisions: this.decisions })
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
