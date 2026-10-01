import type { JSX } from 'react'
import { VenetianMask } from 'lucide-react'
import type { Space } from '@shared/types'
import type { OverviewView } from '@shared/overviewMenu'
import { overviewTitleLabel, PRIVATE_TITLE, tabsWord } from '@renderer/lib/overviewHeader'
import { SpaceGlyph } from '../SpaceGlyph'

/** The title control's `data-testid` (the harness reads the view off `data-view`). */
export const OVERVIEW_TITLE_TESTID = 'overview-title'

interface Props {
  view: OverviewView
  space: Space
  /** The cards the view shows (`overviewCount`). */
  count: number
  /** The space's theme accent for its dot (the Spaces drawer's swatch); none draws the ink ring. */
  dotColor?: string
  /** The Spaces sheet is up: the title reads expanded. */
  spacesOpen: boolean
  onOpenSpaces: () => void
}

/**
 * The tab overview's one header row's title (tab overview cleanup spec §1): the space's dot
 * and name with the count – "Default · 3 tabs" – start-aligned at the grid's gutter, 17/600,
 * and nothing trailing it. THE TITLE IS THE SPACE SWITCHER: a tap opens the Spaces sheet
 * (`SpacesSheet`); a horizontal drag across the grid still moves between spaces (GN-19), the
 * title following. In the private view (§3) the row reads the mask and "Private · N tabs" and
 * is no control: the private session is one across the spaces.
 *
 * Under TalkBack the control is one stop named "Default, 3 tabs" (`overviewTitleLabel`: the
 * typographic dot is not read), a dialog popping up; the words inside are its face.
 */
export function OverviewTitle({
  view,
  space,
  count,
  dotColor,
  spacesOpen,
  onOpenSpaces
}: Props): JSX.Element {
  if (view === 'private') {
    return (
      <div
        className="flex h-11 min-w-0 items-center gap-2.5"
        role="heading"
        aria-level={2}
        aria-label={overviewTitleLabel(PRIVATE_TITLE, count)}
        data-testid={OVERVIEW_TITLE_TESTID}
        data-view="private"
      >
        <VenetianMask className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
        <TitleWords title={PRIVATE_TITLE} count={count} />
      </div>
    )
  }
  return (
    <button
      type="button"
      // The glyph stays at the gutter: the press tint reaches 8 px past it (`-ml-2 pl-2`).
      className="zen-overview-title -ml-2 flex h-11 min-w-0 items-center gap-2.5 rounded-[10px] pl-2 pr-2.5"
      aria-label={overviewTitleLabel(space.name, count)}
      aria-haspopup="dialog"
      aria-expanded={spacesOpen}
      data-testid={OVERVIEW_TITLE_TESTID}
      data-view="tabs"
      onClick={onOpenSpaces}
    >
      <SpaceGlyph icon={space.icon} size={20} dotColor={dotColor} />
      <TitleWords title={space.name} count={count} />
    </button>
  )
}

/**
 * "Default · 3 tabs": the name in the ink, the dot and the count in the muted ink, one line
 * that truncates at the name (the count always shows). The face of a control named by
 * `overviewTitleLabel`, which reads the same words without the dot.
 */
function TitleWords({ title, count }: { title: string; count: number }): JSX.Element {
  return (
    <span className="zen-title flex min-w-0 items-baseline">
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 whitespace-pre text-[var(--zen-muted)]"> · </span>
      <span className="shrink-0 tabular-nums text-[var(--zen-muted)]" data-testid="overview-count">
        {tabsWord(count)}
      </span>
    </span>
  )
}
