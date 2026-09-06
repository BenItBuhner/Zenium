import type { Container, Settings } from './types'
import { DEFAULT_CONTAINER_ID } from './types'

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
  windowSync: 'all'
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
