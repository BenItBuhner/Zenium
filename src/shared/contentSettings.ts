/**
 * The content-settings catalogue: every site permission Zenium knows, with Chrome's default,
 * the words of its prompt and how far each host enforces it. `PermissionService` derives its
 * always-allow / always-deny behaviour and prompt copy from here, and Settings > Site settings
 * lists it row by row, so a new permission type is one entry in this file.
 *
 * Ids are the names the permission store keys on (`origin|<id>`); where an engine has a name
 * for the permission (Electron's handlers, Android's `Permissions.kt`) the id is that name.
 */

export type ContentDecision = 'allow' | 'deny'
/** What sites get without a decision of their own: the answer, or a question. */
export type ContentDefault = ContentDecision | 'ask'

/**
 * How a host honours the setting: `enforced` (the engine asks or obeys), `stored` (remembered
 * and listed, but nothing in the engine acts on it yet), `n-a` (the platform has no such
 * feature, e.g. background sync in the Android WebView, or no path that could act on the row
 * per site, e.g. insecure content on Electron). An `n-a` row is not offered on that host; a
 * value stored for it stays in the store untouched.
 */
export type ContentSupport = 'enforced' | 'stored' | 'n-a'

/** Chrome's grouping of the site-settings page. */
export type ContentGroup = 'permissions' | 'content' | 'additional'

export interface ContentSetting {
  id: string
  /** Row title: "Location", "Camera", "Pop-ups and redirects". */
  label: string
  /** Chrome's sub-line for the built-in default: "Sites can ask for your location". */
  description: string
  /**
   * The sub-line for each default other than the built-in (whose line is `description`), in the
   * register of the design lead's #523 ruling: the Block line "Sites cannot …", the Allow line
   * "Sites can …", one sentence in sentence case, the subject the row's own where the built-in
   * line has one ("Recently closed sites", "Embedded sites", "Fullscreen sites"). Read first by
   * the rows' `defaultDescription` on both hosts; the generic template ("Sites can use <label>
   * without asking" / "Sites cannot use <label>") serves only a value no line is written for,
   * which today is none a row offers – the template said the wrong thing for most rows ("Sites
   * can use automatic downloads without asking"). A row with one choice carries no field.
   */
  descriptions?: Partial<Record<ContentDefault, string>>
  group: ContentGroup
  builtInDefault: ContentDefault
  /** Defaults Settings may choose from (a type that is never asked about has no `ask`). */
  choices: ContentDefault[]
  /**
   * Words after "Allow <site> to …" in the prompt; null for types that are never asked about
   * (the built-in default is the answer, or the engine decides from a gesture).
   */
  promptLabel: string | null
  /** Whether the prompt offers a session-scoped "Allow once" next to Allow and Block. */
  allowOnce: boolean
  support: { desktop: ContentSupport; android: ContentSupport }
  /**
   * The phone's own sub-lines where its engine does less than the desktop's for the same row:
   * the Clipboard row hands a page text alone on Android (MW-38), so its lines say "text" where
   * the desktop's say "text and images". `contentSettingsFor('android')` hands the phone the row
   * with these in place of `description` and, value by value, `descriptions`; the desktop, and
   * `contentSetting(id)`, read the row as written. The prompt's words (`promptLabel`) are one
   * string on both hosts.
   */
  android?: { description: string; descriptions?: Partial<Record<ContentDefault, string>> }
}

/**
 * The catalogue, in the order Settings shows it. Chrome's list of content types is covered in
 * full; the second half holds the permissions Zenium's engines ask about that Chrome folds into
 * other rows or does not expose.
 */
export const CONTENT_SETTINGS: readonly ContentSetting[] = [
  // ---- Permissions -----------------------------------------------------------------------
  {
    id: 'geolocation',
    label: 'Location',
    description: 'Sites can ask for your location',
    descriptions: { deny: 'Sites cannot see your location' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'know your location',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'camera',
    label: 'Camera',
    description: 'Sites can ask to use your camera',
    descriptions: { deny: 'Sites cannot use your camera' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'use your camera',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'microphone',
    label: 'Microphone',
    description: 'Sites can ask to use your microphone',
    descriptions: { deny: 'Sites cannot use your microphone' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'use your microphone',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Sites can ask to send notifications',
    descriptions: { deny: 'Sites cannot send notifications' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'send you notifications',
    allowOnce: false,
    // The Android WebView has no Notification API of its own; the page script's polyfill asks
    // through the same prompt and the host posts under the site's channel (WebNotifications.kt).
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'background-sync',
    label: 'Background sync',
    description: 'Recently closed sites can finish sending and receiving data',
    descriptions: { deny: 'Recently closed sites cannot finish sending or receiving data' },
    group: 'permissions',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'sensors',
    label: 'Motion sensors',
    description: 'Sites can use motion sensors',
    descriptions: { deny: 'Sites cannot use motion sensors' },
    group: 'permissions',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // A page-world guard at document start on both hosts (`contentGuards.ts`): a blocked site's
    // sensors refuse to `start()` and its motion and orientation listeners hear nothing. Neither
    // engine prompts for sensors (Chrome does not either), so the row has no "ask".
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'automatic-downloads',
    label: 'Automatic downloads',
    description: 'Sites can ask to automatically download multiple files',
    descriptions: {
      allow: 'Sites can download multiple files without asking',
      deny: 'Sites cannot download multiple files automatically'
    },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'allow', 'deny'],
    promptLabel: 'download multiple files',
    allowOnce: false,
    // Chrome's DownloadRequestLimiter in the core's downloads service (`core/downloadLimiter.ts`):
    // one download per gesture is free, the next asks this row on both hosts.
    support: { desktop: 'enforced', android: 'enforced' }
  },
  // Chrome's one MIDI setting (`midi-sysex`, ask by default, allow / block / ask:
  // `content_settings_registry.cc:209-217`). Since `kBlockMidiByDefault` (on by default,
  // `blink/common/features.cc:108-109`) every `requestMIDIAccess()` – with or without `sysex` –
  // asks for the SysEx permission (`midi_access_initializer.cc:48-52`), so any Web MIDI request
  // reaches the hosts as that one (Electron's `midiSysex`, the WebView's `RESOURCE_MIDI_SYSEX`;
  // Electron's plain `midi` only with the flag off) and folds into this row (`ALIASES`), as
  // Chrome keeps one row. An Allow lets the page send system-exclusive messages too, as Chrome's
  // does (`midi_sysex_permission_context.cc:34-41`); no one-time allow, as Chrome offers none
  // for it (`permission_request.cc:319-320`).
  {
    id: 'midi',
    label: 'MIDI devices',
    description: 'Sites can ask to control and reprogram your MIDI devices',
    descriptions: { deny: 'Sites cannot control or reprogram your MIDI devices' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'control and reprogram your MIDI devices',
    allowOnce: false,
    // Desktop: Electron's request handler is the core's prompt, and the engine grants the
    // process the SysEx right on an Allow of its own accord (`electron_permission_manager.cc:
    // 72-80`). Android: the WebView asks `onPermissionRequest` with `RESOURCE_MIDI_SYSEX`
    // (`aw_permission_manager.cc:373-378`), which `Permissions.kt` relays as a
    // `permission.request` of `midiSysex` the way it relays the camera's; the core answers from
    // this row and the host grants the resource, whereupon the WebView hands the page the SysEx
    // right itself (`aw_permission_manager.cc:242-246`).
    support: { desktop: 'enforced', android: 'enforced' }
  },
  // The device rows: a chooser is the prompt (`promptLabel` stays null – the site is never asked
  // with a bubble), `block` refuses the site without one, and what a pick grants is one DEVICE
  // (`DeviceGrant`, the setting's data), never a blanket allow.
  {
    id: 'usb',
    label: 'USB devices',
    description: 'Sites can ask to connect to USB devices',
    descriptions: { deny: 'Sites cannot connect to USB devices' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'serial',
    label: 'Serial ports',
    description: 'Sites can ask to connect to serial ports',
    descriptions: { deny: 'Sites cannot connect to serial ports' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'hid',
    label: 'HID devices',
    description: 'Sites can ask to connect to HID devices',
    descriptions: { deny: 'Sites cannot connect to HID devices' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'bluetooth',
    label: 'Bluetooth devices',
    description: 'Sites can ask to connect to Bluetooth devices',
    descriptions: { deny: 'Sites cannot connect to Bluetooth devices' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'fileSystem',
    label: 'File editing',
    description: 'Sites can ask to edit files and folders you pick',
    descriptions: { deny: 'Sites cannot edit files or folders on your device' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'edit files and folders you pick',
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'clipboard-read',
    label: 'Clipboard',
    description: 'Sites can ask to see text and images on your clipboard',
    descriptions: { deny: 'Sites cannot see text or images on your clipboard' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'read from your clipboard',
    allowOnce: true,
    // Desktop: Electron's permission request handler asks this row. Android: the WebView's
    // permission manager refuses every clipboard read, so the page script's shim over
    // `navigator.clipboard.read` / `readText` asks through the same prompt and the host's
    // clipboard answers (`core/clipboardRead.ts`; MW-38). Android 12+ shows the system's paste
    // toast for the app's read, as it does for Chrome's.
    support: { desktop: 'enforced', android: 'enforced' },
    // The phone's path hands the page the clipboard's text alone, so its lines say text until
    // it reads images too (the lead's copy on #657); the prompt's words are the row's.
    android: {
      description: 'Sites can ask to see text on your clipboard',
      descriptions: { deny: 'Sites cannot see text on your clipboard' }
    }
  },
  {
    id: 'payment-handler',
    label: 'Payment handlers',
    description: 'Sites can install payment handlers',
    descriptions: { deny: 'Sites cannot install payment handlers' },
    group: 'permissions',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Desktop: a page-world guard at document start (`contentGuards.ts`) refuses a blocked site's
    // `PaymentRequest` (`show`, `canMakePayment`, `hasEnrolledInstrument`). Android: the system
    // WebView ships no `PaymentRequest` unless the app turns it on
    // (`WebSettingsCompat.setPaymentRequestEnabled`, androidx.webkit 1.14+), which Zenium does
    // not; the row would govern nothing there, so it is not offered. The same guard is wired in
    // the Android page script and acts the day the API is enabled.
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'insecure-content',
    label: 'Insecure content',
    description: 'Insecure content is blocked on secure sites',
    descriptions: { allow: 'Secure sites can show insecure content' },
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Android: an allowed site's document runs with `MIXED_CONTENT_ALWAYS_ALLOW`
    // (`TabWebView.applyMixedContentPolicy`), every other one with the engine's block. Desktop:
    // Electron fixes `allowRunningInsecureContent` per WebContents as it is created and Chromium's
    // renderer-side content-settings agent (the per-site allow) is not in Electron, so no path
    // acts per site – the row is not offered there, the engine's block being the built-in Block.
    support: { desktop: 'n-a', android: 'enforced' }
  },
  {
    id: 'xr',
    label: 'Virtual reality',
    description: 'Zenium does not hand VR or AR devices to sites',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'window-management',
    label: 'Window management',
    description: 'Sites can ask to use information about your screens',
    descriptions: { deny: 'Sites cannot use information about your screens' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'manage windows on all your displays',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'local-fonts',
    label: 'Fonts',
    description: 'Zenium does not list the fonts installed on your device to sites',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'local-network-access',
    label: 'Local network access',
    description: 'Sites can ask to look for and connect to devices on your local network',
    descriptions: { deny: 'Sites cannot look for or connect to devices on your local network' },
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'look for and connect to devices on your local network',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  // ---- Content ---------------------------------------------------------------------------
  {
    id: 'images',
    label: 'Images',
    description: 'Sites can show images',
    descriptions: { deny: 'Sites cannot show images' },
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Desktop: the request engine cancels a blocked page's image requests (`ContentRulesHandler`);
    // Android: `loadsImagesAutomatically` per navigation (`TabWebView.applyContentRules`).
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    description: 'Sites can use JavaScript',
    descriptions: { deny: 'Sites cannot use JavaScript' },
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Desktop: `Emulation.setScriptExecutionDisabled` on the page's session as a blocked
    // site's navigation starts (`ElectronTabView.refreshScripts`); Android: `javaScriptEnabled`
    // per navigation (`TabWebView.applyContentRules`).
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'popups',
    label: 'Pop-ups and redirects',
    description: 'Sites cannot send pop-ups or use redirects without a click',
    descriptions: { allow: 'Sites can send pop-ups and use redirects' },
    group: 'content',
    builtInDefault: 'deny',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'ads',
    label: 'Ads and trackers',
    description: 'Ads and trackers are blocked; excepted sites show them',
    descriptions: { allow: 'Sites can show ads and trackers' },
    group: 'content',
    // The blocking engine reads this row's default as its master switch: `allow` = blocking off.
    builtInDefault: 'deny',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  // The one source of a site's mute: "Mute Site", this row and the site-information row all
  // read and write it, and every tab of the site follows it (`TabManager.followSoundSetting`).
  {
    id: 'sound',
    label: 'Sound',
    description: 'Sites can play sound',
    descriptions: { deny: 'Sites cannot play sound' },
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  // Android only: the WebView pauses a hidden page's video (Chromium's background-video
  // optimisation) and most sites pause on `visibilitychange` besides. For an allowed site the
  // host keeps the playing tab's view shown through the background transition (Home, the lock
  // screen), so neither the engine nor the page learns it was hidden and the audio runs on;
  // the core carries the resolution on the media session (`MediaSessionInfo.backgroundVideo`)
  // and the host reads it at the transition. The desktop has no such transition to gate.
  {
    id: 'background-video',
    label: 'Background video',
    description: 'Sites cannot play video in the background',
    // Not a thing a site asks for, so the template's "without asking" would be wrong here.
    descriptions: { allow: 'Sites can keep playing video in the background' },
    group: 'content',
    builtInDefault: 'deny',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'n-a', android: 'enforced' }
  },
  {
    id: 'zoom-levels',
    label: 'Zoom levels',
    description: 'Zenium zooms per tab, not per site',
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'n-a', android: 'n-a' }
  },
  {
    id: 'pdf',
    label: 'PDF documents',
    description: 'PDF files open in Zenium',
    descriptions: { deny: 'PDF files download instead of opening in Zenium' },
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Desktop: a "download" site's PDF document gets `Content-Disposition: attachment` at
    // `onHeadersReceived` (`ContentRulesHandler`), so the downloads service takes it instead of
    // the viewer. The Android WebView has no PDF viewer of its own; PDFs are downloaded first.
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'mediaKeySystem',
    label: 'Protected content',
    description: 'Sites can ask to play protected content',
    descriptions: {
      allow: 'Sites can play protected content without asking',
      deny: 'Sites cannot play protected content'
    },
    group: 'content',
    builtInDefault: 'ask',
    choices: ['ask', 'allow', 'deny'],
    promptLabel: 'play protected (DRM) content',
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'third-party-sign-in',
    label: 'Third-party sign-in',
    description: 'Sites can show sign-in prompts from identity services',
    descriptions: { deny: 'Sites cannot show sign-in prompts from identity services' },
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Desktop: a page-world guard at document start (`contentGuards.ts`) rejects a blocked site's
    // `navigator.credentials.get({ identity })` (FedCM) with NotAllowedError; passwords and
    // passkeys are untouched. Android: the system WebView has no FedCM at all (no
    // `IdentityCredential`, no WebSettings switch), so the row would govern nothing and is not
    // offered; the guard is wired in the page script for the day it does.
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'on-device-site-data',
    label: 'On-device site data',
    description: 'Sites can save data on your device',
    descriptions: { deny: 'Sites cannot save data on your device' },
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // Folded into the cookie and site-data policy both hosts apply (`ProtectionService.
    // effectiveSiteData`): a blocked site's cookies are withheld both ways and its `Set-Cookie`
    // dropped at the header stages, an allowed site's kept past the third-party rule, the
    // default Block is block-all. "Delete when you close" is the clear-on-exit list of
    // Settings › Cookies and site data.
    support: { desktop: 'enforced', android: 'enforced' }
  },
  // ---- Additional permissions: what Zenium's engines ask about beyond Chrome's rows ------
  {
    id: 'openExternal',
    label: 'Open other apps',
    description: 'Sites can ask to open links in another app',
    descriptions: { deny: 'Sites cannot open links in another app' },
    group: 'additional',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'open links in another app',
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'storage-access',
    label: 'Cookies while embedded',
    description: 'Embedded sites can ask to use the cookies they stored',
    descriptions: {
      allow: 'Embedded sites can use the cookies they stored without asking',
      deny: 'Embedded sites cannot use the cookies they stored'
    },
    group: 'additional',
    builtInDefault: 'ask',
    choices: ['ask', 'allow', 'deny'],
    promptLabel: 'use cookies and site data it has stored',
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'top-level-storage-access',
    label: 'Cookies for embedded sites',
    description: 'Sites can ask to let the sites they embed use their cookies',
    descriptions: {
      allow: 'Sites can let the sites they embed use their cookies without asking',
      deny: 'Sites cannot let the sites they embed use their cookies'
    },
    group: 'additional',
    builtInDefault: 'ask',
    choices: ['ask', 'allow', 'deny'],
    promptLabel: 'let the sites embedded in it use their cookies and site data',
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'idle-detection',
    label: 'Your device use',
    description: 'Sites can ask to know when you are actively using your device',
    descriptions: { deny: 'Sites cannot know when you are actively using your device' },
    group: 'additional',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'know when you are actively using this device',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'fullscreen',
    label: 'Fullscreen',
    description: 'Sites can go fullscreen after a click',
    descriptions: { deny: 'Sites cannot go fullscreen' },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  // Chrome's row of the same name, without its prompt: the desktop enters of its own accord
  // when the video's tab leaves the screen (`MediaSessionService.onVisibleTabsChanged`, MW-28)
  // and says so once per site with a toast carrying "Turn off for this site" (the row's deny).
  // Android's own hook (#223: a fullscreen video's tab left behind on Home) reads the site's
  // answer off the media session (`MediaSessionInfo.autoPictureInPicture`) and enters for an
  // allowed site alone; the user's own picture-in-picture request is not the row's to refuse.
  {
    id: 'auto-picture-in-picture',
    label: 'Automatic picture-in-picture',
    description: 'A playing video moves to a small window when you leave its tab',
    descriptions: {
      deny: 'Sites cannot move a playing video to a small window when you leave its tab'
    },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'pointerLock',
    label: 'Pointer lock',
    description: 'Sites can hide and capture the pointer after a click',
    descriptions: { deny: 'Sites cannot hide or capture the pointer' },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'keyboardLock',
    label: 'Keyboard lock',
    description: 'Fullscreen sites can capture system keys',
    descriptions: { deny: 'Fullscreen sites cannot capture system keys' },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'speaker-selection',
    label: 'Speaker selection',
    description: 'Sites can pick which speaker plays their sound',
    descriptions: { deny: 'Sites cannot pick which speaker plays their sound' },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'clipboard-sanitized-write',
    label: 'Clipboard writes',
    description: 'Sites can copy text and images to your clipboard after a click',
    descriptions: { deny: 'Sites cannot copy text or images to your clipboard' },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    // The picker is the consent (Chrome has no separate screen-sharing prompt): a site the row
    // allows gets the picker, whose cancel refuses the call; a site set to Deny gets no picker.
    id: 'display-capture',
    label: 'Screen sharing',
    description: 'Sites can ask to share your screen, a window or a tab; you pick what they see',
    descriptions: { deny: 'Sites cannot share your screen, a window or a tab' },
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  }
]

const BY_ID = new Map(CONTENT_SETTINGS.map((setting) => [setting.id, setting]))

/**
 * The catalogue as the phone reads it: a row with `android` lines carries them in place of the
 * desktop's (its `descriptions` merged value by value); every other row is the catalogue's own
 * object.
 */
const ANDROID_CONTENT_SETTINGS: readonly ContentSetting[] = CONTENT_SETTINGS.map((setting) => {
  if (!setting.android) return setting
  const { description, descriptions } = setting.android
  return {
    ...setting,
    description,
    ...(descriptions ? { descriptions: { ...setting.descriptions, ...descriptions } } : {})
  }
})

/**
 * The site every local file's decisions are kept under. A `file:` page has no origin (its
 * `URL.origin` is 'null'), so all local files share one site, as Chrome keeps their exceptions
 * under `file:///`.
 */
export const FILE_SITE = 'file://'

/**
 * Engine permission names that are a row under another name: Chromium's finer-grained
 * variants share their row's decision (approximate location is location, periodic background
 * sync is background sync, VR, AR and hand tracking are the one XR row, the SysEx request every
 * Web MIDI call makes is the MIDI row).
 */
const ALIASES: Record<string, string> = {
  'geolocation-approximate': 'geolocation',
  'periodic-background-sync': 'background-sync',
  'background-fetch': 'background-sync',
  vr: 'xr',
  ar: 'xr',
  'hand-tracking': 'xr',
  // Electron's name for Chromium's MIDI_SYSEX permission, which `requestMIDIAccess()` asks for
  // with or without `sysex` since `kBlockMidiByDefault` (`midi_access_initializer.cc:48-52`);
  // the WebView's `RESOURCE_MIDI_SYSEX` arrives under the same name. One MIDI row, as Chrome's.
  midiSysex: 'midi',
  'local-network': 'local-network-access',
  'loopback-network': 'local-network-access'
}

/**
 * Engine permission names Chrome answers without a setting of its own: granted as a matter of
 * course (a video page keeping the screen awake, a site asking for durable storage) and never
 * listed. Everything else without a row is refused, as Chrome refuses what it has no setting for.
 */
const SILENT_DEFAULTS: Record<string, ContentDefault> = {
  'screen-wake-lock': 'allow',
  'persistent-storage': 'allow'
}

/** The row's id a request name stands for (aliases and `openExternal:zoommtg` qualifiers resolved). */
export function contentSettingId(permission: string): string {
  const colon = permission.indexOf(':')
  const base = colon === -1 ? permission : permission.slice(0, colon)
  return ALIASES[base] ?? base
}

/**
 * The permission a request name comes down to: `media` is the camera and microphone rows
 * together, and qualified names (`openExternal:zoommtg`) resolve to their base row.
 */
export function contentSetting(permission: string): ContentSetting | undefined {
  return BY_ID.get(contentSettingId(permission))
}

/** What a site gets for `permission` before any decision is stored. */
export function builtInDefault(permission: string): ContentDefault {
  if (permission === 'media') return 'ask'
  const setting = contentSetting(permission)
  if (setting) return setting.builtInDefault
  return SILENT_DEFAULTS[permission] ?? 'deny'
}

/**
 * Electron's `media` request stands for the camera and microphone rows (which of them, the
 * request's media types say); the answer is stored per row, as Chrome keeps them.
 */
export const MEDIA_ROWS: readonly string[] = ['camera', 'microphone']

/**
 * The rows whose grant is one device picked in a chooser (`DeviceGrant`), never a blanket
 * allow: their `ask` means "a chooser may open", and the engine's status check for them asks
 * "may the site request a device at all?", which anything but `deny` answers yes.
 */
export const DEVICE_KINDS = ['bluetooth', 'usb', 'serial', 'hid'] as const
export type DeviceKindId = (typeof DEVICE_KINDS)[number]

export function isDeviceKind(permission: string): permission is DeviceKindId {
  return (DEVICE_KINDS as readonly string[]).includes(contentSettingId(permission))
}

/**
 * Whether a site's `allow` for `permission` carries the unused-sites clock and can be taken back
 * by the sweep when the site goes unvisited for 60 days (PS-41). Chrome's `CanTrackLastVisit`
 * (`content_settings_info.cc:118-133`): a permission whose initial default is `ask` – here the
 * asked-about rows of the permissions and additional groups, and protected content (Chrome's
 * PROTECTED_MEDIA_IDENTIFIER is such a type) – never notifications, whose review is its own row
 * (Chrome `CHECK`s the type out of the revoke), and never a device kind, whose grant is a device
 * picked in a chooser and never a plain allow. A qualified name (`openExternal:zoommtg`,
 * `storage-access:https://embedder.example`, `fileSystem:read`) reads its row's answer.
 */
export function tracksLastVisit(permission: string): boolean {
  const setting = contentSetting(permission)
  if (!setting || setting.builtInDefault !== 'ask') return false
  if (setting.id === 'notifications' || isDeviceKind(setting.id)) return false
  return (
    setting.group === 'permissions' ||
    setting.group === 'additional' ||
    setting.id === 'mediaKeySystem'
  )
}

/** The words after "Allow <site> to …" for a prompted permission (`null`: never asked). */
export function promptLabelFor(permission: string): string | null {
  if (permission === 'media') return 'use your camera and microphone'
  return contentSetting(permission)?.promptLabel ?? null
}

/** Whether the prompt for `permission` offers "Allow once". */
export function allowOnceFor(permission: string): boolean {
  if (permission === 'media') return true
  return contentSetting(permission)?.allowOnce ?? false
}

/**
 * The rows whose setting this host honours or at least remembers (Settings hides `n-a`), each
 * in the host's own words where a row has any (`android`).
 */
export function contentSettingsFor(
  platform: 'desktop' | 'android',
  include: ContentSupport[] = ['enforced', 'stored']
): ContentSetting[] {
  const catalogue = platform === 'android' ? ANDROID_CONTENT_SETTINGS : CONTENT_SETTINGS
  return catalogue.filter((setting) => include.includes(setting.support[platform]))
}
