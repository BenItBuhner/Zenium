import type { LucideIcon } from 'lucide-react'
import {
  Accessibility,
  Bot,
  CircleFadingArrowUp,
  Container,
  Download,
  Eye,
  Gauge,
  Import,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  Layers,
  LayoutGrid,
  Paintbrush,
  PanelLeft,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
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
  autofill: KeyRound,
  languages: Languages,
  spaces: Waypoints,
  containers: Container,
  boosts: Zap,
  mods: Paintbrush,
  extensions: Puzzle,
  agents: Bot,
  passwords: KeyRound,
  security: ShieldCheck,
  sync: RefreshCw,
  import: Import,
  shortcuts: Keyboard,
  updates: CircleFadingArrowUp,
  about: Info
}

export const SECTION_GLYPH: LucideIcon = Settings
