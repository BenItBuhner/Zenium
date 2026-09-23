import {
  Download,
  FileText,
  History,
  Settings,
  Sparkles,
  Star,
  type LucideIcon
} from 'lucide-react'
import type { InternalPageGlyph } from '@shared/internalPages'

/**
 * The glyph a page tab shows in its favicon slot, by the registry's name (`InternalPageDefinition
 * .glyph`): the pill, the sidebar row, the tab strip and the overview card all draw it from
 * here, so a page registers once and every slot follows (v2 §10.1).
 */
export const PAGE_GLYPHS: Readonly<Record<InternalPageGlyph, LucideIcon>> = {
  settings: Settings,
  history: History,
  star: Star,
  download: Download,
  sparkles: Sparkles,
  'file-text': FileText
}
