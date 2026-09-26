import {
  privateThirdPartyCookieStatus,
  type PreloadPagesLevel,
  type PrivateThirdPartyCookieStatus,
  type ThirdPartyCookiePolicy
} from './privacy'
import type { ExtensionControl } from './types'

/**
 * The extension layer over the user's settings, as the services read it (Chrome's
 * `PrefValueStore`: the extension-controlled layer sits above the user's, so a preference reads
 * the extension's value while one holds it and the user's own again the moment it lets go –
 * `clear`, disable, uninstall). The layer is `UIState.extensionControls`, published whole by the
 * extension host from the values its APIs keep (`chrome.privacy` here; `chrome.fontSettings` has
 * its own apply hook); the user's setting is never written – the two layers stay apart, which is
 * what brings the user's value back at once.
 *
 * The keys are the Settings rows' (`fonts.<pref>` for the font rows; these for the rows the
 * `chrome.privacy` settings shadow), so the row that says "Controlled by <extension>" and the
 * service that acts read one value. The mapping from the API's setting to the key is the
 * extension layer's (`extensionApi/privacy.ts`); the services own the readers.
 */
export const EXTENSION_SETTING_KEYS = {
  /** `services.passwordSavingEnabled` → `Settings.passwords.offerToSave`: the save / update prompt. */
  passwordSaving: 'passwords.offerToSave',
  /** `services.autofillAddressEnabled` → `Settings.autofill.addresses`: address fill and the save offer. */
  autofillAddresses: 'autofill.addresses',
  /** `services.autofillCreditCardEnabled` → `Settings.autofill.cards`: card fill and the save offer. */
  autofillCards: 'autofill.cards',
  /** `services.safeBrowsingEnabled` → `Settings.privacy.safeBrowsingEnabled`: the protection level. */
  safeBrowsing: 'privacy.safeBrowsingEnabled',
  /** `websites.thirdPartyCookiesAllowed` → `Settings.privacy.thirdPartyCookies`: the cookie policy. */
  thirdPartyCookies: 'privacy.thirdPartyCookies',
  /** `services.searchSuggestEnabled` → `Settings.searchSuggestions`: the omnibox's online suggestions. */
  searchSuggestions: 'search.suggestions',
  /** `network.networkPredictionEnabled` → `Settings.preloadPages`: Preload pages (PS-43). */
  preloadPages: 'privacy.preloadPages'
} as const

export type ExtensionSettingKey =
  (typeof EXTENSION_SETTING_KEYS)[keyof typeof EXTENSION_SETTING_KEYS]

export type ExtensionControls = Readonly<Record<string, ExtensionControl>>

/**
 * The layer as a reader takes it: the published map, and whether the run's first publish is
 * still to land (`pending`). The map is not persisted, so a cold start under an enabled
 * extension with persisted `chrome.privacy` values has an interval – the extension host's load,
 * bounded on the desktop by `StartupHold`'s 2 s – in which the layer is empty though a hold is
 * coming. The platform marks the interval (`State.setExtensionLayerPending`) and the first
 * publish that carries one of these keys, or the load's settling, ends it. While it lasts every
 * reader answers the setting's strict pole ({@link STRICT_POLE}), never the user's permissive
 * value: the root's merge condition for #522 – no save or autofill offer, Safe Browsing on,
 * third-party cookies blocked, no online suggestion, no preload – until the extension's own
 * value is known. A layer that is not pending reads `extension ?? user` as before.
 */
export interface ExtensionLayer {
  readonly controls: ExtensionControls
  readonly pending: boolean
}

/** A layer with nothing published and nothing pending: every reader gives the user's value. */
export const EMPTY_EXTENSION_LAYER: ExtensionLayer = Object.freeze({
  controls: Object.freeze({}),
  pending: false
})

/**
 * Each setting's fail-safe pole, the value the readers answer while the layer is pending: the
 * one that offers, sends or allows the least. `safeBrowsing` is the one `true` – protection on
 * is the strict side.
 */
export const STRICT_POLE: Readonly<Record<ExtensionSettingKey, boolean>> = Object.freeze({
  [EXTENSION_SETTING_KEYS.passwordSaving]: false,
  [EXTENSION_SETTING_KEYS.autofillAddresses]: false,
  [EXTENSION_SETTING_KEYS.autofillCards]: false,
  [EXTENSION_SETTING_KEYS.safeBrowsing]: true,
  [EXTENSION_SETTING_KEYS.thirdPartyCookies]: false,
  [EXTENSION_SETTING_KEYS.searchSuggestions]: false,
  [EXTENSION_SETTING_KEYS.preloadPages]: false
})

function strictPole(key: string): boolean | undefined {
  return (STRICT_POLE as Readonly<Record<string, boolean | undefined>>)[key]
}

/**
 * The boolean the layer holds over the setting at `key`: the extension's while one holds it, the
 * strict pole while the layer is pending (for the keys that have one), undefined while none does.
 */
export function extensionBoolean(layer: ExtensionLayer, key: string): boolean | undefined {
  if (layer.pending) {
    const strict = strictPole(key)
    if (strict !== undefined) return strict
  }
  const value = layer.controls[key]?.value
  return typeof value === 'boolean' ? value : undefined
}

/**
 * A switch setting's value in effect: the extension's while one holds it, the user's otherwise.
 * The user's own change while held changes nothing visible (the layer above still answers), and
 * shows again when the layer is withdrawn.
 */
export function effectiveSwitch(layer: ExtensionLayer, key: string, user: boolean): boolean {
  return extensionBoolean(layer, key) ?? user
}

/**
 * The third-party cookie policy in effect: the user's two values, or the extension's boolean
 * read as Chrome reads it. Chrome's `websites.thirdPartyCookiesAllowed` is a boolean over its one
 * three-way `cookie_controls_mode` pref – the same pref the incognito toggle moves – and its
 * `CookieControlsModeTransformer` writes `false` as "Block third-party cookies" (`kBlockThirdParty`,
 * everywhere, never the private-only mode) and `true` as "Allow all cookies" (`kOff`, the
 * incognito block lifted too). So while held, the boolean stands for both of Zenium's values:
 * `false` → the global `block`, under which the private contexts' switch reads locked as under
 * the user's own block; `true` → `allow` with the private override at `default`, so private
 * contexts allow as well. Zenium's `block-private` has no boolean of its own: it reads as allowed
 * (the API's `get` says so) and, like the user's private override, returns whole when the
 * extension lets go – neither is written.
 */
export function effectiveThirdPartyCookiePolicy(
  layer: ExtensionLayer,
  user: ThirdPartyCookiePolicy
): ThirdPartyCookiePolicy {
  const held = extensionBoolean(layer, EXTENSION_SETTING_KEYS.thirdPartyCookies)
  if (held === undefined) return user
  return held
    ? { thirdPartyCookies: 'allow', thirdPartyCookiesPrivate: 'default' }
    : { thirdPartyCookies: 'block', thirdPartyCookiesPrivate: user.thirdPartyCookiesPrivate }
}

/**
 * The private contexts' third-party cookie switch as the chrome shows it, under the layer: the
 * user's own status ({@link privateThirdPartyCookieStatus}) while no extension holds the cookie
 * setting; locked at either pole while one does – on and locked under `false` (the block
 * everywhere, as under the user's own `block`), off and locked under `true` (Chrome's "Allow all
 * cookies", the incognito block lifted too) – since a tap would write a private override the
 * layer above does not read, and the switch would spring back with no word (§9.30: the row at
 * .4, inert, its description the reason). `lockedByExtension` names the holder, or is empty
 * while the name is not to hand: a pending layer, whose strict pole is the block.
 */
export function privateThirdPartyCookieSwitch(
  layer: ExtensionLayer,
  user: ThirdPartyCookiePolicy
): PrivateThirdPartyCookieStatus {
  const key = EXTENSION_SETTING_KEYS.thirdPartyCookies
  const status = privateThirdPartyCookieStatus(effectiveThirdPartyCookiePolicy(layer, user))
  if (extensionBoolean(layer, key) === undefined) return status
  return {
    ...status,
    locked: true,
    lockedByExtension: layer.pending ? '' : (layer.controls[key]?.name ?? '')
  }
}

/**
 * The Preload pages level in effect: the user's, or the extension's boolean over it.
 * `network.networkPredictionEnabled` is a boolean over Chrome's three-way
 * `network_prediction_options` pref; Chrome's `NetworkPredictionTransformer` writes `false` as
 * "no preloading" and `true` as the default level. Here `false` → `none`, and `true` reads as the
 * user's own level (the pass's rule: an extension can switch preloading off, not raise the level
 * a user set to `none` – where Chrome's `true` would land the default level over it).
 */
export function effectivePreloadPages(
  layer: ExtensionLayer,
  user: PreloadPagesLevel
): PreloadPagesLevel {
  const held = extensionBoolean(layer, EXTENSION_SETTING_KEYS.preloadPages)
  if (held === false) return 'none'
  return user
}
