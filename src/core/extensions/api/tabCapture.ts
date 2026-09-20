/**
 * `chrome.tabCapture` and `chrome.desktopCapture` on an engine that has neither binding (Electron
 * registers only its own subset of the extension API features, and these two are in Chrome's
 * list, not its): the argument checks Chrome's `TabCaptureCaptureFunction` /
 * `TabCaptureGetMediaStreamIdFunction` make, the constraints it hands the renderer's binding, the
 * `TabCaptureState` enum and Chrome's error texts. Everything here is pure; the host owns the
 * requests and the engine's stream registry.
 *
 * How a capture reaches the engine: Chrome's binding never carries a `MediaStream` across the API
 * boundary. `getMediaStreamId` answers a stream id and `capture` answers `getUserMedia`
 * constraints naming one (`chromeMediaSource: "tab"`, `chromeMediaSourceId`), and the consuming
 * document calls `getUserMedia` itself. Electron registers such an id for one consuming document
 * (`webContents.getMediaSourceId`), which the caller of `getMediaStreamId` need not be (an MV3
 * worker asks, its offscreen document consumes), so the host mints the id it answers and turns it
 * into the engine's when the consumer's `getUserMedia` call comes through the shim
 * (`TAB_CAPTURE_INTERNAL_METHODS.resolveStreamId`).
 */

export const TAB_CAPTURE_PERMISSION = 'tabCapture'
export const DESKTOP_CAPTURE_PERMISSION = 'desktopCapture'

/** Chrome's `tabCapture.TabCaptureState`. */
export const TAB_CAPTURE_STATES = ['pending', 'active', 'stopped', 'error'] as const
export type TabCaptureState = (typeof TAB_CAPTURE_STATES)[number]

export const TAB_CAPTURE_STATE_CONSTANTS: Record<string, string> = Object.fromEntries(
  TAB_CAPTURE_STATES.map((state) => [state.toUpperCase(), state])
)

/** Chrome's `desktopCapture.DesktopCaptureSourceType`. */
export const DESKTOP_CAPTURE_SOURCE_TYPES = ['screen', 'window', 'tab', 'audio'] as const
export type DesktopCaptureSourceType = (typeof DESKTOP_CAPTURE_SOURCE_TYPES)[number]

export const DESKTOP_CAPTURE_SOURCE_TYPE_CONSTANTS: Record<string, string> = Object.fromEntries(
  DESKTOP_CAPTURE_SOURCE_TYPES.map((type) => [type.toUpperCase(), type])
)

/**
 * The shim's calls the host answers besides the namespace's own methods: `resolveStreamId` turns
 * a stream id this layer minted into the engine's, registered for the calling document the
 * moment it calls `getUserMedia`; `streamState` reports what became of the consuming call
 * (Chrome watches the media request itself; here the consumer's `getUserMedia` is the witness).
 */
export const TAB_CAPTURE_INTERNAL_METHODS = ['resolveStreamId', 'streamState'] as const

// Chrome's texts (`chrome/browser/extensions/api/tab_capture/tab_capture_api.cc`).
export const TAB_CAPTURE_SAME_TAB_ERROR = 'Cannot capture a tab with an active stream.'
export const TAB_CAPTURE_FINDING_TAB_ERROR = 'Error finding tab to capture.'
export const TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR = 'Capture failed. No audio or video requested.'
export const TAB_CAPTURE_GRANT_ERROR =
  'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'
export const TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR =
  'URL scheme for the specified tab is not secure.'
export const TAB_CAPTURE_INVALID_TAB_ERROR = 'Invalid tab specified.'
/** Chrome's answer to a `capture` from a context that has no `getUserMedia` (an MV3 worker). */
export const TAB_CAPTURE_NO_DOCUMENT_ERROR =
  'tabCapture.capture is not available in a service worker; use getMediaStreamId.'

// Chrome's texts (`chrome/browser/extensions/api/desktop_capture/desktop_capture_base.cc`).
export const DESKTOP_CAPTURE_NO_SOURCES_ERROR = 'At least one source type must be specified.'
export const DESKTOP_CAPTURE_INVALID_TAB_ERROR = 'Invalid tab specified.'

/** Chrome's `chromeMediaSource` constraint names (`content/public/common/media_stream_request.h`). */
export const MEDIA_STREAM_SOURCE = 'chromeMediaSource'
export const MEDIA_STREAM_SOURCE_ID = 'chromeMediaSourceId'
export const MEDIA_STREAM_SOURCE_TAB = 'tab'

const CAPTURE_SIGNATURE = 'tabCapture.capture(object options, function callback)'
const STREAM_ID_SIGNATURE =
  'tabCapture.getMediaStreamId(optional object options, optional function callback)'
const CHOOSE_SIGNATURE =
  'desktopCapture.chooseDesktopMedia(array sources, optional tabs.Tab targetTab, function callback)'

/** Chrome's `tabCapture.MediaStreamConstraint`: `mandatory` and an optional `optional`. */
export interface MediaStreamConstraint {
  mandatory: Record<string, unknown>
  optional?: Record<string, unknown>
}

/** Chrome's `tabCapture.CaptureOptions`, checked. */
export interface CaptureOptions {
  audio: boolean
  video: boolean
  audioConstraints?: MediaStreamConstraint
  videoConstraints?: MediaStreamConstraint
  presentationId?: string
}

/** Chrome's `tabCapture.GetMediaStreamOptions`, checked. */
export interface StreamIdOptions {
  consumerTabId?: number
  targetTabId?: number
}

/**
 * `capture`'s options as Chrome's binding checks them: optional booleans `audio` / `video`, the
 * constraint objects when given (`mandatory` optional in Chrome's schema; made present here so the
 * source constraints have somewhere to go), and the function's own check that at least one of
 * audio and video is asked for.
 */
export function normalizeCaptureOptions(raw: unknown): CaptureOptions {
  if (!isRecord(raw)) throw signatureError(CAPTURE_SIGNATURE)
  const audio = optionalBoolean(raw.audio, CAPTURE_SIGNATURE, 'options', 'audio')
  const video = optionalBoolean(raw.video, CAPTURE_SIGNATURE, 'options', 'video')
  const out: CaptureOptions = { audio: audio === true, video: video === true }
  const audioConstraints = optionalConstraint(raw.audioConstraints, 'audioConstraints')
  if (audioConstraints) out.audioConstraints = audioConstraints
  const videoConstraints = optionalConstraint(raw.videoConstraints, 'videoConstraints')
  if (videoConstraints) out.videoConstraints = videoConstraints
  if (raw.presentationId !== undefined) {
    if (typeof raw.presentationId !== 'string') {
      throw propertyError(
        CAPTURE_SIGNATURE,
        'options',
        'presentationId',
        `Invalid type: expected string, found ${typeOf(raw.presentationId)}.`
      )
    }
    out.presentationId = raw.presentationId
  }
  if (!out.audio && !out.video) throw new Error(TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR)
  return out
}

/** `getMediaStreamId`'s options: two optional tab ids. */
export function normalizeStreamIdOptions(raw: unknown): StreamIdOptions {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) throw signatureError(STREAM_ID_SIGNATURE)
  const out: StreamIdOptions = {}
  for (const key of ['consumerTabId', 'targetTabId'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw propertyError(
        STREAM_ID_SIGNATURE,
        'options',
        key,
        `Invalid type: expected integer, found ${typeOf(value)}.`
      )
    }
    out[key] = value
  }
  return out
}

/**
 * Chrome's `AddMediaStreamSourceConstraints`: the constraint object of each requested kind (made
 * when the caller gave none) gets `chromeMediaSource: "tab"` and the stream id under `mandatory`,
 * and the whole options object goes back to the binding, which builds the `getUserMedia` call
 * from `audioConstraints` / `videoConstraints`.
 */
export function withTabSourceConstraints(
  options: CaptureOptions,
  streamId: string
): CaptureOptions {
  const out: CaptureOptions = { ...options }
  const source = (constraint: MediaStreamConstraint | undefined): MediaStreamConstraint => ({
    ...constraint,
    mandatory: {
      ...constraint?.mandatory,
      [MEDIA_STREAM_SOURCE]: MEDIA_STREAM_SOURCE_TAB,
      [MEDIA_STREAM_SOURCE_ID]: streamId
    }
  })
  if (out.audio) out.audioConstraints = source(options.audioConstraints)
  if (out.video) out.videoConstraints = source(options.videoConstraints)
  return out
}

/**
 * Whether a tab's page may be captured: Chrome captures web pages and files, never its own
 * pages (`kGrantError` ends "Chrome pages cannot be captured"); Zenium's `zen://` pages and
 * DevTools stand where Chrome's `chrome://` do.
 */
export function isCapturableUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return !['zen:', 'chrome:', 'devtools:', 'about:'].includes(parsed.protocol)
}

/**
 * Chrome's `network::IsUrlPotentiallyTrustworthy` as `getMediaStreamId` applies it to a consumer
 * tab: secure schemes, the extension's own pages, files, and the loopback host.
 */
export function isPotentiallyTrustworthyUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (['https:', 'wss:', 'chrome-extension:', 'file:', 'zen:'].includes(parsed.protocol))
    return true
  const host = parsed.hostname
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  )
}

/** `chooseDesktopMedia`'s source list: at least one of the enum's values. */
export function normalizeDesktopSources(raw: unknown): DesktopCaptureSourceType[] {
  if (!Array.isArray(raw)) throw signatureError(CHOOSE_SIGNATURE)
  const sources: DesktopCaptureSourceType[] = []
  raw.forEach((value, index) => {
    if (
      typeof value !== 'string' ||
      !(DESKTOP_CAPTURE_SOURCE_TYPES as readonly string[]).includes(value)
    ) {
      throw new TypeError(
        `Error in invocation of ${CHOOSE_SIGNATURE}: Error at parameter 'sources': Error at index ${index}: Value must be one of ${DESKTOP_CAPTURE_SOURCE_TYPES.join(', ')}.`
      )
    }
    if (!sources.includes(value as DesktopCaptureSourceType))
      sources.push(value as DesktopCaptureSourceType)
  })
  if (sources.length === 0) throw new Error(DESKTOP_CAPTURE_NO_SOURCES_ERROR)
  return sources
}

/**
 * What Chrome's picker answers when the user cancels it: an empty stream id and no audio track
 * on offer. The browser layer answers every `chooseDesktopMedia` this way until Zenium has a
 * source picker for extension calls (a UI piece, not an engine one).
 */
export const DESKTOP_CAPTURE_CANCELLED = {
  streamId: '',
  options: { canRequestAudioTrack: false }
} as const

/** `getCapturedTabs` / `onStatusChanged`: Chrome's `tabCapture.CaptureInfo`. */
export interface CaptureInfo {
  tabId: number
  status: TabCaptureState
  fullscreen: boolean
}

function optionalBoolean(
  value: unknown,
  signature: string,
  parameter: string,
  property: string
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw propertyError(
      signature,
      parameter,
      property,
      `Invalid type: expected boolean, found ${typeOf(value)}.`
    )
  }
  return value
}

function optionalConstraint(value: unknown, property: string): MediaStreamConstraint | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw propertyError(
      CAPTURE_SIGNATURE,
      'options',
      property,
      `Invalid type: expected object, found ${typeOf(value)}.`
    )
  }
  const out: MediaStreamConstraint = {
    mandatory: isRecord(value.mandatory) ? { ...value.mandatory } : {}
  }
  if (isRecord(value.optional)) out.optional = { ...value.optional }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function signatureError(signature: string): TypeError {
  return new TypeError(`Error in invocation of ${signature}: No matching signature.`)
}

function propertyError(
  signature: string,
  parameter: string,
  property: string,
  detail: string
): TypeError {
  return new TypeError(
    `Error in invocation of ${signature}: Error at parameter '${parameter}': Error at property '${property}': ${detail}`
  )
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
