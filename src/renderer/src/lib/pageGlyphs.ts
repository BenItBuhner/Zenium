import {
  Activity,
  BookOpen,
  Download,
  FileText,
  History,
  Scale,
  Settings,
  Sparkles,
  Star,
  createLucideIcon,
  type LucideIcon
} from 'lucide-react'
import type { InternalPageGlyph } from '@shared/internalPages'
import { ROLL_MARK, ROLL_MARK_CSS_VARIABLE, rollMarkDot } from '@shared/game/mark'

/**
 * Roll's picture in a favicon slot (§9.17; `shared/game/mark.ts` is the one source, the 1 × 1
 * widget's face is the same numbers): the ring mid-roll with its dot on the inner orbit, resting
 * on a short ground line. The ring and the dot take the brand indigo through `--zen-roll-mark`
 * (the widget's mark rule, `main.css` per theme), the ground the slot's ink; each stroke is the
 * picture's own, as the vector's are, not the slot's Lucide weight. Never the mark alone – that
 * is the app's icon – and never the globe, which is for a site that offered no icon.
 */
const dot = rollMarkDot()
const mark = `var(${ROLL_MARK_CSS_VARIABLE}, currentColor)`
const Roll = createLucideIcon('roll', [
  [
    'line',
    {
      x1: ROLL_MARK.ground.x1,
      y1: ROLL_MARK.ground.y,
      x2: ROLL_MARK.ground.x2,
      y2: ROLL_MARK.ground.y,
      strokeWidth: ROLL_MARK.ground.stroke
    }
  ],
  [
    'circle',
    {
      cx: ROLL_MARK.ring.cx,
      cy: ROLL_MARK.ring.cy,
      r: ROLL_MARK.ring.r,
      stroke: mark,
      strokeWidth: ROLL_MARK.ring.stroke
    }
  ],
  ['circle', { cx: dot.cx, cy: dot.cy, r: dot.r, fill: mark, stroke: 'none' }]
])

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
  scale: Scale,
  sparkles: Sparkles,
  'file-text': FileText,
  activity: Activity,
  'book-open': BookOpen,
  roll: Roll
}
