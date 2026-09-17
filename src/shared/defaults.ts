import type {
  AgentServerStatus,
  AgentSettings,
  CheckupState,
  Container,
  FolderColor,
  PasswordSettings,
  PasswordsStatus,
  ResourceSettings,
  ResourceSnapshot,
  Settings
} from './types'
import { DEFAULT_CONTAINER_ID } from './types'
import { APP_ICON_DEFAULT } from './appIcon'
import { defaultPhoneBar } from './phoneBar'
import { DEFAULT_UPDATE_SETTINGS } from './updates'
import { DEFAULT_PROMO_STATE } from './defaultBrowser'

/** Off until the user turns it on in Settings → AI Agents; loopback only, approval required. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  port: 41735,
  lan: false,
  approveNewAgents: true,
  approvedNames: [],
  defaultMode: 'foreground',
  allowScripts: true,
  showCursor: true
}

export function emptyAgentServerStatus(): AgentServerStatus {
  return { running: false, url: null, lanUrls: [], token: '', error: null }
}

/** Offer to save logins, and ask again a minute after the last re-authentication like Chrome. */
export const DEFAULT_PASSWORD_SETTINGS: PasswordSettings = {
  offerToSave: true,
  reauthGraceSeconds: 60
}

export const MAX_REAUTH_GRACE_SECONDS = 60 * 60

export function sanitizePasswordSettings(
  raw: Partial<PasswordSettings> | undefined | null
): PasswordSettings {
  const d = DEFAULT_PASSWORD_SETTINGS
  const r = raw ?? {}
  const grace = Number(r.reauthGraceSeconds)
  return {
    offerToSave: typeof r.offerToSave === 'boolean' ? r.offerToSave : d.offerToSave,
    reauthGraceSeconds: Number.isFinite(grace)
      ? Math.max(0, Math.min(MAX_REAUTH_GRACE_SECONDS, Math.round(grace)))
      : d.reauthGraceSeconds
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
    checkup: emptyCheckupState()
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
  sidebarWidth: 240,
  sidebarExpanded: true,
  sidebarExpandOnHover: false,
  borderless: false,
  compactMode: {
    enabled: false,
    hideSidebar: true,
    hideToolbar: false,
    sidebarPersistent: false
  },
  urlbarBehavior: 'float-typing',
  phoneBarPosition: 'bottom',
  phoneBar: defaultPhoneBar(),
  pullToRefresh: true,
  glanceEnabled: true,
  glanceTrigger: 'alt',
  pinnedCloseBehavior: 'reset-unload-switch',
  pinnedResetOnStartup: false,
  thirdPartyOnPinned: 'new-tab',
  unloadEnabled: true,
  unloadTimeoutMinutes: 20,
  unloadExcludedDomains: [],
  searchEngineId: 'google',
  searchSuggestions: true,
  containerSpecificEssentials: true,
  essentialsMax: 12,
  newTabPosition: 'end',
  restoreSession: true,
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
  defaultBrowserPromo: structuredClone(DEFAULT_PROMO_STATE)
}

/** Firefox's four default containers plus "No Container". */
export const DEFAULT_CONTAINERS: Container[] = [
  { id: DEFAULT_CONTAINER_ID, name: 'No Container', color: 'toolbar', icon: 'circle' },
  { id: 'personal', name: 'Personal', color: 'blue', icon: 'fingerprint' },
  { id: 'work', name: 'Work', color: 'orange', icon: 'briefcase' },
  { id: 'banking', name: 'Banking', color: 'green', icon: 'dollar' },
  { id: 'shopping', name: 'Shopping', color: 'pink', icon: 'cart' }
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

/** Tab group colours, in the order a new group picks the first one its space is not using yet. */
export const FOLDER_COLORS: Record<FolderColor, string> = {
  blue: '#4c8dff',
  green: '#34b56f',
  orange: '#f0913c',
  purple: '#9b6bff',
  pink: '#f26fa8',
  cyan: '#2fb7c9',
  yellow: '#e2b53a',
  red: '#ee5f5b',
  grey: '#8a8f9c'
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
