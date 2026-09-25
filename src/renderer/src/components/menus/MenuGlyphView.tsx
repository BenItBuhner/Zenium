import type { JSX } from 'react'
import { ArrowRight, Download, House, Info } from 'lucide-react'
import type { MenuGlyph } from '@shared/types'
import { ReloadStopGlyph, StarGlyph } from '../phone/BarGlyphs'

/**
 * The phone app menu's icon row's still glyphs (TB-08), the bar's own drawings for the same
 * actions (`barItems.tsx`); the star is the row's one stateful glyph and draws through
 * `StarGlyph` (`MenuItemGlyph` below puts the two together).
 */
export function MenuGlyphView({ glyph }: { glyph: Exclude<MenuGlyph, 'star'> }): JSX.Element {
  switch (glyph) {
    case 'forward':
      return <ArrowRight aria-hidden />
    case 'home':
      return <House aria-hidden />
    case 'download':
      return <Download aria-hidden />
    case 'info':
      return <Info aria-hidden />
    case 'reload':
    case 'stop':
      return <ReloadStopGlyph loading={glyph === 'stop'} />
  }
}

/** An icon row item's glyph, the star at the fill `filled` says, any other as it is drawn at rest. */
export function MenuItemGlyph({
  glyph,
  filled = false
}: {
  glyph: MenuGlyph | undefined
  filled?: boolean
}): JSX.Element {
  if (glyph === 'star') return <StarGlyph filled={filled} />
  return <MenuGlyphView glyph={glyph ?? 'info'} />
}
