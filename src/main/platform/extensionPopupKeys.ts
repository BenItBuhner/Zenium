import type { KeyEventInput } from '../../core/platform'

/**
 * A key event as Electron hands it to `before-input-event` – the fields the key table reads.
 * Typed here rather than as Electron's `Input` so the router needs no Electron to be tested.
 */
export interface PopupKeyInput {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  isAutoRepeat: boolean
}

export interface PopupKeyHost {
  /** Close the popup for the Escape the document trapped (`closePopup('escape')`). */
  close(): void
  /**
   * The key table of the window the popup belongs to, for a key of the chrome (a null tab id:
   * `KeyboardHandler.handle(input, null, win)`). True when the table took the key.
   */
  handle(input: KeyEventInput): boolean
}

/**
 * A key in a browser-action popup's document (`ElectronExtensionHost.openPopup`). Escape's key
 * down closes the popup, as Chrome's do; every other key – down and up – goes through the
 * owning window's key table as a key of the chrome, so a Zenium shortcut runs from a popup as
 * it does from the toolbar, an extension command reaches its extension, and the quit chord is
 * held rather than quitting at once: the chord's key down arms `QuitHoldService` in the
 * popup's window (unconsumed, so its key up can be seen) and its key up releases it. Without
 * this route the popup's ⌘Q went unhandled to the menu bar's Quit role, whose plain quit
 * request nothing refused – the one path on which the chord quit without the hold with Warn
 * Before Quitting on (review F3). Returns true when the host is to consume the event.
 */
export function popupKey(input: PopupKeyInput, host: PopupKeyHost): boolean {
  if (input.type === 'keyDown' && input.key === 'Escape') {
    host.close()
    return true
  }
  return host.handle({
    type: input.type as KeyEventInput['type'],
    key: input.key,
    control: input.control,
    alt: input.alt,
    shift: input.shift,
    meta: input.meta,
    isAutoRepeat: input.isAutoRepeat
  })
}
