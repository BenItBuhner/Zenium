import type { JSX } from 'react'
import { hideFollowsCover } from '@renderer/lib/cover'
import type { ReaderCrossingState } from '@renderer/lib/readerTransition'
import { cn } from '@renderer/lib/utils'
import { CoverImage } from './CoverImage'
import './readerCrossing.css'

interface Props {
  crossing: ReaderCrossingState
  /** How the page's picture fits its box – the frame's cover fit, so the swap is invisible. */
  fit: string
}

/**
 * The reader crossing's layer in the content frame (MOT-36; `lib/readerTransition.ts`): the
 * page's picture where the page is – a tracked cover, so the live view goes only once the
 * picture is painted – and over it the reader's surface, the ground the destination paints,
 * at 0 while the page is on its way off and fading to 1 the moment the picture is what shows
 * (`readerCrossing.css`: 120 ms on `--zen-ease`, §11). With no picture to be had the surface
 * shows at once – a cut to the ground rather than a frame of the chassis behind the page. The
 * surface stands through `loading` and `landing`, until the host has drawn the destination in
 * its place and the crossing ends. A frozen surface (`freezeAt`) is the preview host's still of
 * the crossing mid-way.
 */
export function ReaderCrossing({ crossing, fit }: Props): JSX.Element {
  const { tabId, picture, surface, phase, freezeAt } = crossing
  const shown = phase !== 'covering' || picture === null
  const frozen = freezeAt !== undefined
  return (
    <div
      className="zen-reader-crossing"
      data-testid="reader-crossing"
      data-crossing={crossing.crossing}
      data-phase={phase}
      aria-hidden
    >
      {picture && (
        <CoverImage
          tabId={tabId}
          src={picture}
          cover={hideFollowsCover()}
          className={cn('absolute inset-0 h-full w-full', fit)}
        />
      )}
      <div
        className="zen-reader-crossing-surface"
        data-testid="reader-crossing-surface"
        data-shown={shown || undefined}
        data-frozen={frozen || undefined}
        style={{ background: surface, opacity: frozen ? freezeAt : undefined }}
      />
    </div>
  )
}
