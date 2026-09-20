/**
 * Screen capture on a desktop engine (Electron, MW-19): the picker is Chrome's consent, so
 * cancelling it must refuse the page's `getDisplayMedia` with `NotAllowedError: Permission
 * denied` – which on Electron only the permission stage can produce (the display-media handler's
 * refusals surface as an `AbortError`). The picker therefore runs at the permission stage, where
 * Electron does not yet say whether the page asked for audio. The page's own call does: a shim
 * in the page's main world wraps `getDisplayMedia` and tells the browser, synchronously and
 * before the engine sees the call, whether audio was requested, so the picker can offer "Also
 * share audio" exactly when Chrome's would.
 */

/** Synchronous ask of the main process: `true` when the call asked for audio. */
export const SCREEN_CAPTURE_INTENT_CHANNEL = 'zen:display-capture-intent'

/** DOM event the main world dispatches on `document` before each call, `detail` the audio flag. */
export const SCREEN_CAPTURE_INTENT_EVENT = 'zen-display-capture-intent'

/** The isolated world's transport. */
export interface ScreenCaptureBridgeTransport {
  /** Tell the browser a call is coming and whether it asked for audio; returns when it knows. */
  intent(audio: boolean): void
  /** Run `installScreenCaptureShim` in the main world. */
  installShim(eventName: string): void
}

/**
 * Runs in the page's main world (serialised, self-contained; never throws into the page): wraps
 * `MediaDevices.prototype.getDisplayMedia` so the page's constraints are announced before the
 * engine's own call proceeds. The call itself, its promise and its errors are the engine's.
 */
export function installScreenCaptureShim(eventName: string): void {
  const win = globalThis as Window & typeof globalThis
  const proto = (win as unknown as { MediaDevices?: { prototype: MediaDevices } }).MediaDevices
    ?.prototype
  if (!proto) return
  const native = proto.getDisplayMedia
  if (typeof native !== 'function') return
  const wrapped = function (
    this: MediaDevices,
    constraints?: DisplayMediaStreamOptions
  ): Promise<MediaStream> {
    try {
      const audio = Boolean(
        constraints && typeof constraints === 'object' && (constraints as { audio?: unknown }).audio
      )
      win.document.dispatchEvent(new CustomEvent(eventName, { detail: audio }))
    } catch {
      /* the announcement is best effort; the call goes on */
    }
    return native.call(this, constraints)
  }
  try {
    // The engine's function has no declared parameters and its own name; a page comparing the
    // two (feature probes read `length` and `name`) sees the same.
    Object.defineProperty(wrapped, 'length', { value: native.length, configurable: true })
    Object.defineProperty(wrapped, 'name', { value: native.name, configurable: true })
    Object.defineProperty(proto, 'getDisplayMedia', {
      configurable: true,
      writable: true,
      value: wrapped
    })
  } catch {
    /* a frozen prototype keeps the engine's own */
  }
}

/** The isolated-world half: hears the announcement and passes it to the browser. */
export function installScreenCaptureBridge(
  transport: ScreenCaptureBridgeTransport,
  eventName: string = SCREEN_CAPTURE_INTENT_EVENT
): void {
  document.addEventListener(eventName, (e) => {
    try {
      transport.intent((e as CustomEvent<unknown>).detail === true)
    } catch {
      /* the browser is unreachable; the call falls back to the engine's own asking */
    }
  })
  transport.installShim(eventName)
}
