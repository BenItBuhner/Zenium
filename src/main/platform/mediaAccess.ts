/**
 * macOS asks the user once per application whether it may use the camera and the microphone
 * (TCC), in a dialog of the system's; Electron puts the question through
 * `systemPreferences.askForMediaAccess` and reads the answer through `getMediaAccessStatus`.
 * Zenium asks the system before the first site prompt for a device (os-59): the dialog comes up
 * where a Chrome user expects it – on the first page that wants the camera – and a refusal by
 * the system ends the request as denied, without a site prompt whose Allow could not be honoured.
 *
 * Pure apart from the system object handed in: the tests drive it with a fake.
 */

export type MediaDeviceKind = 'camera' | 'microphone'

/** Electron's `getMediaAccessStatus` answers. */
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/** The slice of Electron's `systemPreferences` the gate uses. */
export interface SystemMediaAccess {
  getMediaAccessStatus(kind: MediaDeviceKind): MediaAccessStatus
  askForMediaAccess(kind: MediaDeviceKind): Promise<boolean>
}

export interface MediaAccessGateOptions {
  /** The process's platform; the gate only ever asks on `darwin`. */
  platform: NodeJS.Platform
  system: SystemMediaAccess
  /**
   * The system refused a device (or the user did, in the system's dialog): called once per
   * device kind per run, so the user learns where to allow it without being nagged on every
   * request a page retries.
   */
  onRefused?: (kind: MediaDeviceKind, status: MediaAccessStatus) => void
}

/** The device kinds a `media` request's types name, camera first, each once. */
export function mediaDeviceKinds(mediaTypes: ReadonlyArray<'video' | 'audio'>): MediaDeviceKind[] {
  const kinds: MediaDeviceKind[] = []
  if (mediaTypes.includes('video')) kinds.push('camera')
  if (mediaTypes.includes('audio')) kinds.push('microphone')
  return kinds
}

export class MediaAccessGate {
  /** The system's dialog in flight per kind: concurrent requests share it. */
  private readonly asking = new Map<MediaDeviceKind, Promise<boolean>>()
  private readonly refusedTold = new Set<MediaDeviceKind>()

  constructor(private readonly options: MediaAccessGateOptions) {}

  /**
   * Whether the system lets Zenium use every device the request names. Off macOS always true.
   * On macOS a device the system has not been asked about yet is asked for now (the system's
   * dialog; one at a time per kind), one it refuses (`denied`, `restricted`, or a status the gate
   * does not know) refuses the request at once, without a dialog for the other device.
   */
  async allows(mediaTypes: ReadonlyArray<'video' | 'audio'>): Promise<boolean> {
    if (this.options.platform !== 'darwin') return true
    const kinds = mediaDeviceKinds(mediaTypes)
    const statuses = kinds.map((kind) => [kind, this.status(kind)] as const)
    const refused = statuses.find(
      ([, status]) => status !== 'granted' && status !== 'not-determined'
    )
    if (refused) {
      this.refuse(refused[0], refused[1])
      return false
    }
    for (const [kind, status] of statuses) {
      if (status === 'granted') continue
      if (!(await this.ask(kind))) {
        this.refuse(kind, this.status(kind))
        return false
      }
    }
    return true
  }

  private status(kind: MediaDeviceKind): MediaAccessStatus {
    try {
      return this.options.system.getMediaAccessStatus(kind)
    } catch {
      return 'unknown'
    }
  }

  private ask(kind: MediaDeviceKind): Promise<boolean> {
    const inFlight = this.asking.get(kind)
    if (inFlight) return inFlight
    const promise = Promise.resolve()
      .then(() => this.options.system.askForMediaAccess(kind))
      .catch(() => false)
      .finally(() => this.asking.delete(kind))
    this.asking.set(kind, promise)
    return promise
  }

  private refuse(kind: MediaDeviceKind, status: MediaAccessStatus): void {
    if (this.refusedTold.has(kind)) return
    this.refusedTold.add(kind)
    this.options.onRefused?.(kind, status)
  }
}

/** What the user is told, once, when the system withholds a device from Zenium. */
export function mediaRefusedMessage(kind: MediaDeviceKind): string {
  const device = kind === 'camera' ? 'camera' : 'microphone'
  const pane = kind === 'camera' ? 'Camera' : 'Microphone'
  return `macOS is not letting Zenium use the ${device}. Allow it in System Settings → Privacy & Security → ${pane}.`
}
