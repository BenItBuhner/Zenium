import type {
  AgentServerStatus,
  AgentSettings,
  Container,
  ResourceSettings,
  ResourceSnapshot,
  Settings
} from './types'
import { DEFAULT_CONTAINER_ID } from './types'

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
  agents: structuredClone(DEFAULT_AGENT_SETTINGS)
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
