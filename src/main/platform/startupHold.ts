/**
 * The run's first documents wait for the extension layer's first publish (services pass 10,
 * #522 – the root's merge condition).
 *
 * `chrome.privacy`'s effective values reach the core as `UIState.extensionControls`, which is
 * not persisted: the extension API host publishes the map when it loads an extension
 * (`extensionApi/privacy.ts` `load` → `recompute` → `publishControls`), inside Electron's
 * `extension-loaded` event – an asynchronous step of the default session's
 * `ExtensionService.attachSession`, which awaits `loadExtension` per record. The core's decision
 * points that read the layer (the password, address and card offers, the Safe Browsing lookup
 * and the lookalike check, the third-party cookie rule, the suggestions fetch, the preload
 * refusal) are every one borne by a document: a page's first navigation, or the chrome's own for
 * what the user types. So the platform holds the documents – every tab view's first
 * `loadURL` / `restoreNavigation` and every chrome window's document – until that load settles,
 * and only when the hold can matter: when an enabled extension has persisted `chrome.privacy`
 * values (`ApiStore.privacyValues`). With none, the layer's first publish is empty and every
 * read of it is the user's own value: no order to keep, no hold.
 *
 * Bounded: a load that neither resolves nor rejects within `EXTENSION_LAYER_HOLD_MS` lets the
 * documents go (Chrome has no such wait – its extension prefs are in the profile's prefs file,
 * read before any window – and no such hang either). The bound stays under the chrome window's
 * `READY_TO_SHOW_FALLBACK_MS`, so the hold alone never shows a window without its document.
 *
 * The bound fails safe: the documents it lets go of are not read against the user's values. The
 * platform marks the layer pending for the same interval (`State.setExtensionLayerPending`,
 * `platform/index.ts`), and every reader of a pending layer answers its setting's strict pole
 * (`shared/extensionSettings.ts` `STRICT_POLE`: no save or autofill offer, Safe Browsing on,
 * third-party cookies blocked, no online suggestion, no preload) until the first publish that
 * carries a privacy key lands, or the load settles. The hold is the order; the pending layer is
 * what the order protects when the bound fires first. Neither stalls the UI thread: a decision
 * point answers strict at once, it never waits.
 */
export const EXTENSION_LAYER_HOLD_MS = 2000

export class StartupHold {
  /** What waits for the hold to open; null while it is open. */
  private waiting: Array<() => void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  /** Open: nothing waits, `run` runs at once. */
  get open(): boolean {
    return this.waiting === null
  }

  /**
   * Close the hold until `load` settles – resolved or rejected – or `boundMs` passes, whichever
   * comes first; a hold already closed keeps the close it has.
   */
  until(
    load: Promise<unknown>,
    boundMs = EXTENSION_LAYER_HOLD_MS,
    warn: (message: string) => void = (message) => console.warn(message)
  ): void {
    if (this.waiting !== null) return
    const waiting: Array<() => void> = []
    this.waiting = waiting
    const timer = setTimeout(() => {
      if (this.waiting !== waiting) return
      warn(
        `[zen] extensions: the extension layer took longer than ${boundMs} ms to load; the first documents go ahead`
      )
      this.release()
    }, boundMs)
    timer.unref?.()
    this.timer = timer
    const done = (): void => {
      if (this.waiting === waiting) this.release()
    }
    load.then(done, done)
  }

  /** Run `fn` now while the hold is open, else once it opens, in the order asked. */
  run(fn: () => void): void {
    if (this.waiting === null) fn()
    else this.waiting.push(fn)
  }

  /** Resolves once the hold is open (at once while it is). */
  whenOpen(): Promise<void> {
    return new Promise((resolve) => this.run(resolve))
  }

  private release(): void {
    const waiting = this.waiting
    if (waiting === null) return
    this.waiting = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const fn of waiting) {
      try {
        fn()
      } catch (error) {
        console.error('[zen] startup hold: a held document failed to load', error)
      }
    }
  }
}

/**
 * Whether the hold can matter: an enabled extension has persisted `chrome.privacy` values, so
 * its load publishes a layer that may differ from the user's settings. A disabled extension is
 * not loaded and holds nothing; one without values publishes nothing the user's values do not
 * already say.
 */
export function extensionLayerNeedsHold(
  records: ReadonlyArray<{ id: string; enabled: boolean }>,
  privacyValues: (id: string) => Record<string, unknown>
): boolean {
  return records.some(
    (record) => record.enabled && Object.keys(privacyValues(record.id)).length > 0
  )
}
