import type { LucideIcon } from 'lucide-react'
import {
  Accessibility,
  Bot,
  CircleFadingArrowUp,
  Container,
  Download,
  Eye,
  Gauge,
  Globe,
  Info,
  KeyRound,
  Keyboard,
  Layers,
  LayoutGrid,
  Paintbrush,
  PanelLeft,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Waypoints,
  Zap
} from 'lucide-react'

/**
 * The glyph of each Settings category on the phone landing (v2 §10.2: the desktop nav's icon
 * set, 20 px at stroke 1.75, `--v2-text`). Looked up as `SECTION_GLYPHS[id] ?? SECTION_GLYPH`:
 * a category registered without one gets the gear.
 */
export const SECTION_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  look: Eye,
  accessibility: Accessibility,
  compact: PanelLeft,
  newtab: LayoutGrid,
  tabs: Layers,
  downloads: Download,
  privacy: Shield,
  resources: Gauge,
  search: Search,
  spaces: Waypoints,
  containers: Container,
  boosts: Zap,
  mods: Paintbrush,
  extensions: Puzzle,
  agents: Bot,
  passwords: KeyRound,
  sync: RefreshCw,
  shortcuts: Keyboard,
  'default-browser': Globe,
  updates: CircleFadingArrowUp,
  about: Info
}

export const SECTION_GLYPH: LucideIcon = Settings
