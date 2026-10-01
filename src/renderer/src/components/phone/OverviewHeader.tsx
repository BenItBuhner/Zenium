import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, VenetianMask } from 'lucide-react'
import type { Space } from '@shared/types'
import type { OverviewView } from '@shared/overviewMenu'
import { overviewTitleLabel, PRIVATE_TITLE, tabsWord } from '@renderer/lib/overviewHeader'
import { SpaceGlyph } from '../SpaceGlyph'
import { PANE_FADE_MS } from './PaneSlot'

/** The title control's `data-testid` (the harness reads the view off `data-view`). */
export const OVERVIEW_TITLE_TESTID = 'overview-title'

/** How long the words that were stand fading over the words that are at a space switch (§6). */
export const TITLE_FADE_MS = PANE_FADE_MS

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
 * and name with the count – "Default · 3 tabs" – start-aligned at the grid's gutter, 17/600.
 * THE TITLE IS THE SPACE SWITCHER: a tap opens the Spaces sheet (`SpacesSheet`); a horizontal
 * drag across the grid still moves between spaces (GN-19), the title following – its words
 * cross-fade over 120 ms at the switch (§6, `TitleWords`). Its one mark that it is a control
 * is a 16 chevron-down after its text, 4 past the count at the window's 69 % ink (the count's),
 * out of the accessibility tree, turning over the state change's 120 ms while the sheet stands
 * (`.zen-overview-title-chevron` in main.css, keyed to `aria-expanded`); nothing else trails
 * the title. In the private view (§3) the row reads the mask and "Private · N tabs" and is no
 * control, so it carries no chevron: the private session is one across the spaces.
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
        className="flex h-11 min-w-0 items-center"
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
      className="zen-overview-title -ml-2 flex h-11 min-w-0 items-center rounded-[10px] pl-2 pr-2.5"
      aria-label={overviewTitleLabel(space.name, count)}
      aria-haspopup="dialog"
      aria-expanded={spacesOpen}
      data-testid={OVERVIEW_TITLE_TESTID}
      data-view="tabs"
      onClick={onOpenSpaces}
    >
      <SpaceGlyph icon={space.icon} size={20} dotColor={dotColor} />
      <TitleWords title={space.name} count={count} switchKey={space.id} />
      <ChevronDown
        className="zen-overview-title-chevron ml-1 h-4 w-4 shrink-0"
        strokeWidth={1.75}
        aria-hidden
        data-testid="overview-title-chevron"
      />
    </button>
  )
}

/** The words that were, standing over the words that are while they fade (§6). */
interface WordsStill {
  key: number
  title: string
  count: number
}

let stillSeq = 0

/**
 * "Default · 3 tabs": the name in the ink, the dot and the count in the muted ink, one line
 * that truncates at the name (the count always shows). The face of a control named by
 * `overviewTitleLabel`, which reads the same words without the dot. A change of `switchKey`
 * – the space, at a switch (GN-19, the Spaces sheet, the menu) – cross-fades the words over
 * `TITLE_FADE_MS` (§6): the words that were are kept over the new ones as a still fading out
 * (`.zen-overview-title-still`, opacity alone) while the new ones stand beneath from the first
 * frame; a count that changes within one space is a cut, as the grid's card count is.
 */
function TitleWords({
  title,
  count,
  switchKey
}: {
  title: string
  count: number
  switchKey?: string
}): JSX.Element {
  const [still, setStill] = useState<WordsStill | null>(null)
  const last = useRef({ switchKey, title, count })
  useEffect(() => {
    const was = last.current
    last.current = { switchKey, title, count }
    if (switchKey === undefined || was.switchKey === undefined || was.switchKey === switchKey)
      return
    setStill({ key: ++stillSeq, title: was.title, count: was.count })
  }, [switchKey, title, count])
  useEffect(() => {
    if (!still) return
    const timer = setTimeout(() => setStill(null), TITLE_FADE_MS)
    return () => clearTimeout(timer)
  }, [still])
  return (
    // The 10 from the glyph is the words' own: the chevron after them keeps its 4 (§1).
    <span className="relative ml-2.5 flex min-w-0">
      <Words title={title} count={count} />
      {still && (
        <span
          key={still.key}
          className="zen-overview-title-still absolute inset-0 flex min-w-0"
          aria-hidden
          data-testid="overview-title-still"
        >
          <Words title={still.title} count={still.count} still />
        </span>
      )}
    </span>
  )
}

function Words({
  title,
  count,
  still = false
}: {
  title: string
  count: number
  /** The fading copy: it carries no hook of the live words'. */
  still?: boolean
}): JSX.Element {
  return (
    <span className="zen-title flex min-w-0 items-baseline">
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 whitespace-pre text-[var(--zen-muted)]"> · </span>
      <span
        className="shrink-0 tabular-nums text-[var(--zen-muted)]"
        data-testid={still ? undefined : 'overview-count'}
      >
        {tabsWord(count)}
      </span>
    </span>
  )
}
