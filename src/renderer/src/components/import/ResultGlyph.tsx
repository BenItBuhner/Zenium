import type { JSX } from 'react'
import { CircleAlert } from 'lucide-react'
import type { OutcomeState } from '@renderer/lib/importData'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH } from '../v2/controls'
import { StatusGlyph } from '../siteControls/pane'

/**
 * A result's glyph in the §1 status ink, one drawing for the desktop's two surfaces – the
 * dialog's result (its headline and each kind's row) and the pane's Last import row: ok for
 * what came in, the danger ink for a failure – the ink its text takes, since a failed import is
 * an error and reads in `--v2-danger` like every other error message (§9.33) – and the aside
 * glyph where nothing came in and nothing failed. `StatusGlyph`'s warning is the site-safety
 * ink and is not an import's. The phone's rows tell the same three states trailing
 * (`importRows`, `outcomeGlyph`).
 */
export function ResultGlyph({
  state,
  className
}: {
  state: OutcomeState
  className?: string
}): JSX.Element {
  if (state === 'error')
    return (
      <CircleAlert className={cn(V2_GLYPH, 'text-[var(--v2-danger)]', className)} aria-hidden />
    )
  return <StatusGlyph state={state === 'ok' ? 'safe' : 'info'} className={className} />
}
