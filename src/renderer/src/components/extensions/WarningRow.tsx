import type { JSX } from 'react'
import { warningGlyph } from '@renderer/lib/extensions/warningGlyph'
import { V2Row } from './v2'
import { WARNING_GLYPHS } from './warningGlyphs'

/** One of Chrome's permission warnings as a row: a glyph for its kind, then the sentence. */
export function WarningRow({ warning }: { warning: string }): JSX.Element {
  return <V2Row lead={WARNING_GLYPHS[warningGlyph(warning)]} label={warning} />
}
