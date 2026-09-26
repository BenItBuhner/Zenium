/**
 * The page-world guards of the content settings neither engine has a switch for: motion sensors
 * (the Generic Sensor API and the device orientation events), third-party sign-in (FedCM through
 * `navigator.credentials.get({ identity })`) and payment handlers (`PaymentRequest`). Chrome
 * refuses them in the renderer from its content settings; Electron exposes no `sensors`,
 * `identity` or `payment-handler` permission to `setPermissionRequestHandler` and the Android
 * WebView has no switch either, so a blocked site's document gets the refusal from a script at
 * document start, before any of the page's own runs.
 *
 * `installContentGuards` is serialised into the page's main world (`contextBridge.executeInMainWorld`
 * on Electron; the Android page script is in that world already), so it must not reach for
 * anything outside its own body.
 */

/** The guarded rows, as `blockedGuardsFor` names them (`contentRules.ts`). */
export type ContentGuardId = 'sensors' | 'third-party-sign-in' | 'payment-handler'

/**
 * Refuse the blocked APIs in this document; safe to call with an empty list (does nothing). The
 * desktop page preload gets the list as the `guards` field of its one document-start ask
 * (`documentStart.ts`); the Android page script reads it from its document-start literals.
 */
export function installContentGuards(blocked: readonly string[]): void {
  if (!blocked || blocked.length === 0) return
  const w = window as unknown as Record<string, unknown>
  const refusal = (name: string, message: string): DOMException => new DOMException(message, name)

  if (blocked.includes('sensors')) {
    // Chrome's block: `start()` fires the sensor's `error` event with `NotAllowedError`.
    const Sensor = w.Sensor as (new () => EventTarget) | undefined
    if (Sensor && Sensor.prototype) {
      const SensorErrorEvent = w.SensorErrorEvent as
        (new (type: string, init: { error: DOMException }) => Event) | undefined
      Object.defineProperty(Sensor.prototype, 'start', {
        configurable: true,
        writable: true,
        value: function start(this: EventTarget): void {
          const error = refusal('NotAllowedError', 'Permissions to access sensor are not granted')
          setTimeout(
            (target: EventTarget) => {
              const event = SensorErrorEvent
                ? new SensorErrorEvent('error', { error })
                : Object.assign(new Event('error'), { error })
              target.dispatchEvent(event)
            },
            0,
            this
          )
        }
      })
    }
    // The device orientation events deliver nothing: listeners register nowhere and the
    // `on…` handlers hold nothing (`'ondevicemotion' in window` stays true, as in Chrome).
    const silenced = new Set(['devicemotion', 'deviceorientation', 'deviceorientationabsolute'])
    const addEventListener = window.addEventListener.bind(window)
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: function (type: string, ...rest: unknown[]): void {
        if (silenced.has(String(type).toLowerCase())) return
        ;(addEventListener as (...args: unknown[]) => void)(type, ...rest)
      }
    })
    for (const name of ['ondevicemotion', 'ondeviceorientation', 'ondeviceorientationabsolute'])
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => null,
        set: () => undefined
      })
  }

  if (blocked.includes('third-party-sign-in')) {
    // FedCM: `navigator.credentials.get({ identity })` is refused; passwords and public keys
    // keep working, as Chrome's third-party sign-in setting leaves them alone.
    const container = w.CredentialsContainer as
      { prototype: { get: (options?: unknown) => Promise<unknown> } } | undefined
    if (container && container.prototype && typeof container.prototype.get === 'function') {
      const get = container.prototype.get
      Object.defineProperty(container.prototype, 'get', {
        configurable: true,
        writable: true,
        value: function (this: unknown, options?: unknown): Promise<unknown> {
          if (options && typeof options === 'object' && 'identity' in options)
            return Promise.reject(
              refusal(
                'NotAllowedError',
                'Third-party sign-in is blocked for this site (Zenium site settings)'
              )
            )
          return get.call(this, options)
        }
      })
    }
  }

  if (blocked.includes('payment-handler')) {
    // Payment handlers: no payment app may serve the site, so `canMakePayment()` says no and
    // `show()` fails as it does in Chrome when no handler can be used.
    const request = w.PaymentRequest as
      | {
          prototype: {
            show: (details?: unknown) => Promise<unknown>
            canMakePayment: () => Promise<boolean>
            hasEnrolledInstrument?: () => Promise<boolean>
          }
        }
      | undefined
    if (request && request.prototype) {
      Object.defineProperty(request.prototype, 'show', {
        configurable: true,
        writable: true,
        value: (): Promise<unknown> =>
          Promise.reject(
            refusal(
              'NotSupportedError',
              'Payment handlers are blocked for this site (Zenium site settings)'
            )
          )
      })
      Object.defineProperty(request.prototype, 'canMakePayment', {
        configurable: true,
        writable: true,
        value: (): Promise<boolean> => Promise.resolve(false)
      })
      if (typeof request.prototype.hasEnrolledInstrument === 'function')
        Object.defineProperty(request.prototype, 'hasEnrolledInstrument', {
          configurable: true,
          writable: true,
          value: (): Promise<boolean> => Promise.resolve(false)
        })
    }
  }
}
