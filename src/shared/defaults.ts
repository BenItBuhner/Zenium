import type {
  AgentServerStatus,
  AgentSettings,
  AutofillSettings,
  AutofillUIState,
  CheckupState,
  Container,
  FolderColor,
  InactiveTabsArchiveDays,
  PasswordSettings,
  PasswordsStatus,
  ResourceSettings,
  ResourceSnapshot,
  Settings
} from './types'
import { DEFAULT_CONTAINER_ID, emptyCheckupSummary } from './types'
import { APP_ICON_DEFAULT } from './appIcon'
import { defaultPhoneBar } from './phoneBar'
import { DEFAULT_NEW_TAB_SETTINGS } from './newTab'
import { DEFAULT_UPDATE_SETTINGS } from './updates'
import { DEFAULT_PROMO_STATE } from './defaultBrowser'
import { DEFAULT_BLOCKING_SETTINGS } from './blocking'
import { DEFAULT_PAGE_CONTROLS } from './pageControls'
import { DEFAULT_PRIVACY_SETTINGS } from './privacy'
import { DEFAULT_SPELLCHECK } from './spellcheck'
import { DEFAULT_READER_PREFERENCES } from './reader'
import { DEFAULT_READ_ALOUD_SETTINGS } from './readAloud'
import { DEFAULT_FONT_SETTINGS } from './fonts'
import { FALLBACK_LANGUAGES } from './languages'

/**
 * Off until the user turns it on in Settings → AI Agents; loopback only, approval required.
 * Page scripting (`browser_evaluate`) is a separate opt-in: an agent that can run arbitrary
 * JavaScript in the user's pages can read and exfiltrate anything they are signed in to.
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  port: 41735,
  lan: false,
  approveNewAgents: true,
  approvedNames: [],
  defaultMode: 'foreground',
  allowScripts: false,
  showCursor: true
}

export function emptyAgentServerStatus(): AgentServerStatus {
  return { running: false, url: null, lanUrls: [], token: '', error: null }
}

/**
 * Offer to save logins, ask again a minute after the last re-authentication like Chrome, never
 * sign in without the picker, leave Android's autofill service in charge where one is set, clear
 * a copied secret from the clipboard after a minute (Bitwarden's default; Chrome never does),
 * and warn about a breached password at sign-in (Chrome's default too).
 */
export const DEFAULT_PASSWORD_SETTINGS: PasswordSettings = {
  offerToSave: true,
  reauthGraceSeconds: 60,
  autoSignIn: false,
  androidProvider: 'system',
  clipboardClearSeconds: 60,
  leakDetection: true
}

export const MAX_REAUTH_GRACE_SECONDS = 60 * 60
export const MAX_CLIPBOARD_CLEAR_SECONDS = 60 * 60

export function sanitizePasswordSettings(
  raw: Partial<PasswordSettings> | undefined | null
): PasswordSettings {
  const d = DEFAULT_PASSWORD_SETTINGS
  const r = raw ?? {}
  const grace = Number(r.reauthGraceSeconds)
  const clear = Number(r.clipboardClearSeconds)
  return {
    offerToSave: typeof r.offerToSave === 'boolean' ? r.offerToSave : d.offerToSave,
    reauthGraceSeconds: Number.isFinite(grace)
      ? Math.max(0, Math.min(MAX_REAUTH_GRACE_SECONDS, Math.round(grace)))
      : d.reauthGraceSeconds,
    autoSignIn: typeof r.autoSignIn === 'boolean' ? r.autoSignIn : d.autoSignIn,
    androidProvider:
      r.androidProvider === 'zenium' || r.androidProvider === 'system'
        ? r.androidProvider
        : d.androidProvider,
    clipboardClearSeconds: Number.isFinite(clear)
      ? Math.max(0, Math.min(MAX_CLIPBOARD_CLEAR_SECONDS, Math.round(clear)))
      : d.clipboardClearSeconds,
    leakDetection: typeof r.leakDetection === 'boolean' ? r.leakDetection : d.leakDetection
  }
}

export const DEFAULT_AUTOFILL_SETTINGS: AutofillSettings = { addresses: true, cards: true }

export function sanitizeAutofillSettings(
  raw: Partial<AutofillSettings> | undefined | null
): AutofillSettings {
  const d = DEFAULT_AUTOFILL_SETTINGS
  const r = raw ?? {}
  return {
    addresses: typeof r.addresses === 'boolean' ? r.addresses : d.addresses,
    cards: typeof r.cards === 'boolean' ? r.cards : d.cards
  }
}

export function emptyAutofillUIState(): AutofillUIState {
  return {
    prompts: [],
    picker: null,
    addressCount: 0,
    cardCount: 0,
    passkeyCount: 0,
    systemAutofill: null,
    revision: 0
  }
}

export function emptyCheckupState(): CheckupState {
  return {
    running: false,
    checked: 0,
    total: 0,
    finishedAt: null,
    error: null,
    compromised: [],
    weak: [],
    reused: [],
    unchecked: []
  }
}

export function emptyPasswordsStatus(): PasswordsStatus {
  return {
    locked: true,
    protection: { os: false, passphrase: false },
    osKeystore: false,
    osReauth: false,
    count: 0,
    neverSave: [],
    revision: 0,
    error: null,
    checkup: emptyCheckupState(),
    checkupSummary: emptyCheckupSummary(),
    leaks: [],
    leakChecks: []
  }
}

/**
 * Aggressive out of the box: the browser as a whole may use about a third of the machine's RAM
 * and half of its CPU; hidden tabs are frozen after five minutes and unloaded after twenty
 * (`unloadTimeoutMinutes`), at most 24 pages stay alive, and pages cannot keep old documents or
 * prerenders around.
 */
export const DEFAULT_RESOURCE_SETTINGS: ResourceSettings = {
  enabled: true,
  enforcement: 'strict',
  memoryMb: 0,
  memoryPercent: 35,
  cpuPercent: 50,
  gpuMemoryMb: 0,
  gpuMode: 'auto',
  freezeAfterMinutes: 5,
  idleFreezeMinutes: 10,
  maxLoadedTabs: 24,
  maxConcurrentLoads: 3,
  batteryFactor: 0.7,
  protectPinned: false,
  protectEssentials: false,
  protectAudible: true,
  process: {
    rendererProcessLimit: 0,
    rendererHeapMb: 0,
    lowEndDeviceMode: false,
    disableSpareRenderer: true,
    disableBackForwardCache: true,
    disablePrerender: true,
    rasterThreads: 0,
    v8OptimizeForSize: false
  }
}

/**
 * The Inactive tabs threshold's ladder (TAB-20, SET-34), in days: Never, then Chrome's three
 * (`ARCHIVE_TIME_DELTA_DAYS_OPTS`); the default is Chrome 152's 21.
 */
export const INACTIVE_TABS_ARCHIVE_DAYS: readonly InactiveTabsArchiveDays[] = [0, 7, 14, 21]

/**
 * How long an archived tab waits before the auto-close sweep takes it, in days: Chrome 152's
 * `DEFAULT_AUTODELETE_TIME_HOURS` (90 days). Settings words it in months the way Chrome's
 * `getAutoDeleteTimeDeltaMonths` does (days / 30, so "3 months").
 */
export const INACTIVE_TAB_AUTO_CLOSE_DAYS = 90

export function emptyResourceSnapshot(): ResourceSnapshot {
  const gauge = { used: 0, budget: 0, configured: 0 }
  return {
    sampledAt: 0,
    memory: { ...gauge },
    cpu: { ...gauge },
    gpu: { ...gauge },
    system: { totalMemoryMb: 0, cpuCount: 0, onBattery: false, idle: false },
    tabs: [],
    overheadMb: 0,
    loadedTabs: 0,
    frozenTabs: 0,
    throttledTabs: 0,
    queuedLoads: 0,
    pressure: [],
    recentActions: [],
    restartRequired: false
  }
}

export const DEFAULT_SETTINGS: Settings = {
  colorScheme: 'system',
  appIcon: APP_ICON_DEFAULT,
  toolbarLayout: 'single',
  sidebarSide: 'left',
  devtoolsDock: 'bottom',
  sidebarWidth: 240,
  sidebarExpanded: true,
  sidebarExpandOnHover: false,
  borderless: false,
  windowMaterial: 'none',
  compactMode: {
    enabled: false,
    hideSidebar: true,
    hideToolbar: false,
    sidebarPersistent: false
  },
  urlbarBehavior: 'float-typing',
  phoneBarPosition: 'bottom',
  phoneBar: defaultPhoneBar(),
  // Chrome's default: a homepage that is the new tab page, so a profile's optional Home button
  // (#52) keeps working when the setting arrives; "Off" is a choice.
  homepage: { mode: 'newtab', url: '' },
  pullToRefresh: true,
  hideToolbarOnScroll: true,
  glanceEnabled: true,
  glanceTrigger: 'alt',
  splitEdgeZones: true,
  pinnedCloseBehavior: 'reset-unload-switch',
  pinnedResetOnStartup: false,
  thirdPartyOnPinned: 'new-tab',
  unloadEnabled: true,
  unloadTimeoutMinutes: 20,
  unloadExcludedDomains: [],
  inactiveTabsArchiveDays: 21,
  inactiveTabsAutoClose: true,
  mutedHosts: [],
  searchEngineId: 'google',
  searchEngines: [],
  searchSuggestions: true,
  historySuggestions: true,
  bookmarkSuggestions: true,
  showFullUrls: false,
  containerSpecificEssentials: true,
  essentialsMax: 12,
  newTabPosition: 'end',
  restoreSession: true,
  warnOnCloseWindow: true,
  confirmCloseAll: true,
  crashRestore: 'ask',
  askWhereToSave: false,
  onboardingDone: false,
  showTabSeparator: true,
  ctrlTabCyclesWithinSection: false,
  spaceRouting: {},
  windowSync: 'all',
  resources: structuredClone(DEFAULT_RESOURCE_SETTINGS),
  agents: structuredClone(DEFAULT_AGENT_SETTINGS),
  updates: structuredClone(DEFAULT_UPDATE_SETTINGS),
  externalProtocols: {},
  passwords: structuredClone(DEFAULT_PASSWORD_SETTINGS),
  autofill: structuredClone(DEFAULT_AUTOFILL_SETTINGS),
  defaultBrowserPromo: structuredClone(DEFAULT_PROMO_STATE),
  defaultBrowserPromptDismissed: null,
  blocking: structuredClone(DEFAULT_BLOCKING_SETTINGS),
  pageControls: structuredClone(DEFAULT_PAGE_CONTROLS),
  bookmarksBar: 'newtab',
  shortcutPreset: 'chrome',
  privacy: structuredClone(DEFAULT_PRIVACY_SETTINGS),
  newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS),
  gestureHintDone: false,
  fullscreenHintDone: false,
  spellcheck: structuredClone(DEFAULT_SPELLCHECK),
  reader: structuredClone(DEFAULT_READER_PREFERENCES),
  readAloud: structuredClone(DEFAULT_READ_ALOUD_SETTINGS),
  fonts: structuredClone(DEFAULT_FONT_SETTINGS),
  // A profile takes the OS's languages as it loads (`defaultLanguages`); this stands in until then.
  languages: [...FALLBACK_LANGUAGES]
}

/** Firefox's four default containers plus "No Container". */
export const DEFAULT_CONTAINERS: Container[] = [
  { id: DEFAULT_CONTAINER_ID, name: 'No Container', color: 'toolbar', icon: 'circle' },
  { id: 'personal', name: 'Personal', color: 'blue', icon: 'fingerprint' },
  { id: 'work', name: 'Work', color: 'orange', icon: 'briefcase' },
  { id: 'banking', name: 'Banking', color: 'green', icon: 'dollar' },
  { id: 'shopping', name: 'Shopping', color: 'pink', icon: 'cart' }
]

/** Firefox's container glyphs, in the order the pickers offer them. */
export const CONTAINER_ICONS: readonly Container['icon'][] = [
  'fingerprint',
  'briefcase',
  'dollar',
  'cart',
  'circle',
  'gift',
  'vacation',
  'food',
  'fruit',
  'pet',
  'tree',
  'chill',
  'fence'
]

export const CONTAINER_COLORS: Record<Container['color'], string> = {
  blue: '#37adff',
  turquoise: '#00c79a',
  green: '#51cd00',
  yellow: '#ffcb00',
  orange: '#ff9f00',
  red: '#ff613d',
  pink: '#ff4bda',
  purple: '#af51f5',
  toolbar: '#8f8f9d'
}

/*
 * Tab group colours (design language v2 §9.14): a PAIR, one set a scheme, since the rule is that
 * every group colour reads at least 3:1 against the window fill it sits on in its scheme – the
 * light sidebar (`BASE_LIGHT`, 242 241 245) and the light window gradient's band (the Zenium
 * Purple preset at the window's strength, #d0c2fb at its darkest), the dark sidebar (`BASE_DARK`,
 * 28 28 32) and the dark gradient's band; `shared/__tests__/folderColors.test.ts` holds every
 * value to it. One set for both themes could not: the old nine put eight under 3:1 on the light
 * sidebar. The renderer carries both sets on every element that wears a group colour and the
 * theme picks (`lib/groups.ts`, `groupColorVars`), so a reader never has to know the scheme.
 *
 * LIGHT is Chrome's light tab-group set (Chromium's classic palette in
 * chrome/browser/ui/color/chrome_color_mixer.cc: kGoogleGrey700, Blue600, Red600, Yellow600,
 * Green700, Pink700, Purple500, Cyan900, Orange400 of ui/gfx/color_palette.h) with the five that
 * fail the rule deepened – the hue and the saturation kept, the lightness lowered until every
 * fill reads 3:1: yellow #f9ab00 → #976700 and orange #fa903e → #b75305, too pale for either fill
 * (1.7:1 and 2.1:1 on the sidebar); blue #1a73e8 → #166cdd, red #d93025 → #d52f24 and purple
 * #a142f4 → #9c37f3, each over 4:1 on the sidebar but 2.7–2.9:1 on the band's darkest run.
 * DARK is Chrome's dark set as it stands (the kGoogle*300 tints), 4.5:1 and up on both fills.
 * Both records keep one key order: a new group on the phone takes the first key its space is not
 * using yet (`nextGroupColor`); the core's order is `FOLDER_COLOR_ORDER`.
 */
export const FOLDER_COLORS_LIGHT: Record<FolderColor, string> = {
  blue: '#166cdd',
  green: '#188038',
  orange: '#b75305',
  purple: '#9c37f3',
  pink: '#d01884',
  cyan: '#007b83',
  yellow: '#976700',
  red: '#d52f24',
  grey: '#5f6368'
}

export const FOLDER_COLORS_DARK: Record<FolderColor, string> = {
  blue: '#8ab4f8',
  green: '#81c995',
  orange: '#fcad70',
  purple: '#c58af9',
  pink: '#ff8bcb',
  cyan: '#78d9ec',
  yellow: '#fdd663',
  red: '#f28b82',
  grey: '#dadce0'
}

/**
 * The nine colours in Chrome's order – the order its group editor lays the swatches out in and
 * the order it hands them to new groups (grey first, then blue…). The desktop's folder editor
 * bubble and the core's colour for a new folder follow it (tabs-13).
 */
export const FOLDER_COLOR_ORDER: readonly FolderColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
]

/** What each colour is called: the swatch's name to assistive technology, the menu's radio item. */
export const FOLDER_COLOR_NAMES: Record<FolderColor, string> = {
  grey: 'Grey',
  blue: 'Blue',
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  pink: 'Pink',
  purple: 'Purple',
  cyan: 'Cyan',
  orange: 'Orange'
}

/** Privacy- and productivity-focused sites, mirroring Zen's onboarding essentials picks. */
export const ONBOARDING_ESSENTIALS: Array<{ title: string; url: string }> = [
  { title: 'Proton Mail', url: 'https://mail.proton.me/' },
  { title: 'Notion', url: 'https://www.notion.so/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'Mastodon', url: 'https://mastodon.social/' },
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Reddit', url: 'https://www.reddit.com/' },
  { title: 'Figma', url: 'https://www.figma.com/' }
]

export const SPACE_ICONS: string[] = [
  '🏠',
  '💼',
  '📚',
  '🎨',
  '🎵',
  '🎮',
  '🛒',
  '💬',
  '🧪',
  '🌍',
  '🚀',
  '❤️',
  '⭐',
  '🔥',
  '🌙',
  '☀️',
  '🍀',
  '🐱',
  '🐶',
  '🎯',
  '📝',
  '💡',
  '🔧',
  '🎓'
]

/**
 * Text label for a space ("💼 Work"). Symbolic icons (`sym:<name>`) are drawn as glyphs by the
 * renderer and have no text form, so labels fall back to the plain name.
 */
export function spaceLabel(space: { icon: string; name: string }): string {
  const emoji = space.icon && !space.icon.startsWith('sym:') ? `${space.icon} ` : ''
  return `${emoji}${space.name}`
}

export const FOLDER_ICONS: string[] = ['📁', '📂', '🗂️', '📌', '🔖', '🧩', '🎉', '🛠️', '🧭', '🗃️']
