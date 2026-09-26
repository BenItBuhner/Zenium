import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Leaf } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import {
  ENERGY_SAVER_BUTTON,
  ENERGY_SAVER_TITLE,
  ENERGY_SAVER_TURN_OFF,
  closeEnergySaverBubble,
  energySaverAnchor,
  energySaverDetail,
  energySaverLeafUp,
  energySaverUi,
  turnOffEnergySaverForSession
} from '@renderer/lib/energySaver'
import { useViewport } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, toRect } from '@renderer/lib/portals'
import { pinsFor } from '@renderer/lib/toolbarPins'
import { browserStore } from '@renderer/lib/ui'
import { DesktopPopover, ListRow, Separator, TitleBlock } from '../siteControls/primitives'
import { V2_GLYPH } from '../v2/controls'

/** The bubble while it is open, above whichever shell is up (mounted once in `Root`). */
export function EnergySaverBubbleLayer(): JSX.Element | null {
  const open = energySaverUi.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <EnergySaverBubble state={state} />
}

/** The row under the title block: Chrome's cancel button, "Turn off now", with what "now" means here. */
export const TURN_OFF_DETAIL = 'Until the next time your computer is unplugged.'

/**
 * Chrome's battery saver bubble (`BatterySaverBubbleView`; W8-2, settings-29) as a §9.20 popover
 * 320 wide hanging from the toolbar row, aligned with the leaf, through the chrome layer over a
 * picture of the page (`useFloatingChrome`; it holds its first paint until the picture is in
 * place). Chrome's bubble is a title, a paragraph, OK and "Turn off now"; here, in the desktop
 * popover's vocabulary (the Memory Saver bubble's precedent, omnibox-40): a title block (§9.23)
 * – the leaf on the title's start, "Energy Saver is on", the one sentence on what that does
 * here in Zenium's words (§9.1) – and, below a hairline, "Turn off now" as a menu-style row
 * (§9.20's list-panel footer) that asks the governor to drop the mode for this battery session
 * and closes; OK is the light dismiss. The keyboard lands on the panel, not on the row (§9.22's
 * `container`: a notice with one affordance arms nothing, as Chrome's default button is its
 * no-op OK), Tab reaches the row, Escape returns the keyboard to the leaf; a press anywhere else,
 * a resize and another popover opening put it away. The mode going off – the charger, the
 * threshold, "Turn off now" landing, the setting – or the leaf leaving the row take the bubble
 * with them: it spoke for a leaf that is gone.
 */
function EnergySaverBubble({ state }: { state: UIState }): JSX.Element | null {
  const [fromKeyboard] = useState(() => energySaverUi.get().fromKeyboard)
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  const { formFactor } = useViewport()
  const gone = !energySaverLeafUp(state, pinsFor(state, formFactor))
  // Hangs from the leaf in its row, measured again on a window resize and on every state push
  // (the row's buttons come and go with the tab and the snapshot).
  const [rects, setRects] = useState(leafRects)
  useEffect(() => {
    const measure = (): void => setRects(leafRects())
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state])
  const titleId = 'zen-energy-saver-title'
  if (!ready) return null
  return (
    <DesktopPopover
      anchor={rects.anchor}
      bar={rects.bar}
      width={POPOVER_WIDTH.list}
      labelledBy={titleId}
      closing={gone}
      onClosed={closeEnergySaverBubble}
      focus="container"
      anchorElement={energySaverAnchor}
      data-testid="energy-saver-bubble"
    >
      {({ close }) => (
        <>
          <TitleBlock
            id={titleId}
            glyph={<Leaf className={V2_GLYPH} aria-hidden />}
            title={ENERGY_SAVER_TITLE}
            description={energySaverDetail(state)}
          />
          <div className="pb-1">
            <Separator />
            <ListRow
              label={ENERGY_SAVER_TURN_OFF}
              description={TURN_OFF_DETAIL}
              onClick={() => {
                turnOffEnergySaverForSession()
                close()
              }}
              data-energy-saver-off=""
            />
          </div>
        </>
      )}
    </DesktopPopover>
  )
}

/**
 * The leaf and the bar it sits in, in window coordinates, for `placePopover`: the toolbar row
 * (`data-bar`) on the desktop and the tablet, so the bubble's top sits flush under the row and
 * its alignment follows the leaf's half of it; the leaf's own box in the compact column, which
 * has no bar; both null while no leaf is laid out (the bubble then leaves, `closing`).
 */
function leafRects(): { anchor: Rect | null; bar: Rect | null } {
  const button = document.querySelector<HTMLElement>(ENERGY_SAVER_BUTTON)
  if (!button) return { anchor: null, bar: null }
  const anchor = toRect(button.getBoundingClientRect())
  if (anchor.width === 0 && anchor.height === 0) return { anchor: null, bar: null }
  const bar = button.closest('[data-bar]')
  return { anchor, bar: bar ? toRect(bar.getBoundingClientRect()) : anchor }
}
