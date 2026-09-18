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
 * feature, e.g. web notifications in the Android WebView).
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
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'send you notifications',
    allowOnce: false,
    // The Android WebView has no Notification API.
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'background-sync',
    label: 'Background sync',
    description: 'Recently closed sites can finish sending and receiving data',
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
    group: 'permissions',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  {
    id: 'automatic-downloads',
    label: 'Automatic downloads',
    description: 'Sites can ask to download several files at once',
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'allow', 'deny'],
    promptLabel: 'download several files',
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  {
    id: 'midi',
    label: 'MIDI devices',
    description: 'Sites can ask to connect to MIDI devices',
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'access MIDI devices',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'usb',
    label: 'USB devices',
    description: 'Zenium does not connect sites to USB devices',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'serial',
    label: 'Serial ports',
    description: 'Zenium does not connect sites to serial ports',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'hid',
    label: 'HID devices',
    description: 'Zenium does not connect sites to HID devices',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'bluetooth',
    label: 'Bluetooth devices',
    description: 'Zenium does not connect sites to Bluetooth devices',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'fileSystem',
    label: 'File editing',
    description: 'Sites can ask to edit files and folders you pick',
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
    group: 'permissions',
    builtInDefault: 'ask',
    choices: ['ask', 'deny'],
    promptLabel: 'read from your clipboard',
    allowOnce: true,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'payment-handler',
    label: 'Payment handlers',
    description: 'Sites can install payment handlers',
    group: 'permissions',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  {
    id: 'insecure-content',
    label: 'Insecure content',
    description: 'Insecure content is blocked on secure sites',
    group: 'permissions',
    builtInDefault: 'deny',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
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
  // ---- Content ---------------------------------------------------------------------------
  {
    id: 'images',
    label: 'Images',
    description: 'Sites can show images',
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    description: 'Sites can use JavaScript',
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  {
    id: 'popups',
    label: 'Pop-ups and redirects',
    description: 'Sites cannot send pop-ups or use redirects without a click',
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
    group: 'content',
    // The blocking engine reads this row's default as its master switch: `allow` = blocking off.
    builtInDefault: 'deny',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  },
  {
    id: 'sound',
    label: 'Sound',
    description: 'Sites can play sound',
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
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
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    // The Android WebView has no PDF viewer; PDFs are downloaded.
    support: { desktop: 'stored', android: 'n-a' }
  },
  {
    id: 'mediaKeySystem',
    label: 'Protected content',
    description: 'Sites can ask to play protected content',
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
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  {
    id: 'on-device-site-data',
    label: 'On-device site data',
    description: 'Sites can save data on your device',
    group: 'content',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'stored', android: 'stored' }
  },
  // ---- Additional permissions: what Zenium's engines ask about beyond Chrome's rows ------
  {
    id: 'openExternal',
    label: 'Open other apps',
    description: 'Sites can ask to open links in another application',
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
    group: 'additional',
    builtInDefault: 'allow',
    choices: ['allow', 'deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'display-capture',
    label: 'Screen sharing',
    description: 'Zenium does not share your screen with sites',
    group: 'additional',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'n-a' }
  },
  {
    id: 'midiSysex',
    label: 'MIDI system messages',
    description: 'Zenium does not let sites send system-exclusive MIDI messages',
    group: 'additional',
    builtInDefault: 'deny',
    choices: ['deny'],
    promptLabel: null,
    allowOnce: false,
    support: { desktop: 'enforced', android: 'enforced' }
  }
]

const BY_ID = new Map(CONTENT_SETTINGS.map((setting) => [setting.id, setting]))

/**
 * The permission a request name comes down to: `media` is the camera and microphone rows
 * together, and qualified names (`openExternal:zoommtg`) resolve to their base row.
 */
export function contentSetting(permission: string): ContentSetting | undefined {
  const colon = permission.indexOf(':')
  return BY_ID.get(colon === -1 ? permission : permission.slice(0, colon))
}

/** What a site gets for `permission` before any decision is stored. */
export function builtInDefault(permission: string): ContentDefault {
  if (permission === 'media') return 'ask'
  const setting = contentSetting(permission)
  // Permission names no row knows are refused, as Chrome refuses what it has no setting for.
  return setting ? setting.builtInDefault : 'deny'
}

/**
 * Electron's `media` request stands for the camera and microphone rows (which of them, the
 * request's media types say); the answer is stored per row, as Chrome keeps them.
 */
export const MEDIA_ROWS: readonly string[] = ['camera', 'microphone']

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

/** The rows whose setting this host honours or at least remembers (Settings hides `n-a`). */
export function contentSettingsFor(
  platform: 'desktop' | 'android',
  include: ContentSupport[] = ['enforced', 'stored']
): ContentSetting[] {
  return CONTENT_SETTINGS.filter((setting) => include.includes(setting.support[platform]))
}
