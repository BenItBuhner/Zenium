import type { JSX } from 'react'
import { useLayoutEffect } from 'react'
import { Leaf } from 'lucide-react'
import {
  ENERGY_SAVER_TITLE,
  energySaverUi,
  toggleEnergySaverBubble
} from '@renderer/lib/energySaver'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { TOOLBAR_STROKE } from '../v2/controls'

/**
 * Chrome's battery saver toolbar button (`BatterySaverButton`; W8-2, settings-29) in the
 * toolbar row: the leaf, there while Energy Saver is on and gone the moment it is not – the
 * charger plugged in, the battery back over the threshold, "Turn off now", the setting turned
 * off – as Chrome's is (`BatterySaverButtonController`: shown on the mode's active state, hidden
 * on its inactive). The row mounts it (`NavRow`, `energySaverLeafUp`: the mode on and the
 * control pinned; `energySaverLeafFits`: the row wide enough to keep its pill, pr-584 L2),
 * ahead of the media hub's button as Chrome's stands ahead of its media button. Its press opens
 * the bubble (`EnergySaverBubble`) under the row and closes it again (the chrome layer's light
 * dismiss takes a pointer press while the bubble is up; the keyboard's press gets here).
 * Chrome's one line – tooltip, accessible name and the bubble's title – is "Energy Saver is
 * on", so the name is the state and the tooltip says nothing twice. The button publishes its
 * own standing (`energySaverUi.leafUp`) from the commit that mounts or unmounts it, so a bubble
 * up as the width tier folds the leaf leaves with it, before the frame paints (§9.20).
 */
export function EnergySaverButton(): JSX.Element {
  const open = energySaverUi.use((s) => s.open)
  useLayoutEffect(() => {
    energySaverUi.set({ leafUp: true })
    return () => energySaverUi.set({ leafUp: false })
  }, [])
  return (
    <button
      type="button"
      data-zen-energy-saver-button
      // The pressed fill while the bubble is up is the toolbar button's own, off `aria-expanded`.
      className="zen-toolbar-button relative"
      data-tooltip={ENERGY_SAVER_TITLE}
      aria-label={ENERGY_SAVER_TITLE}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => toggleEnergySaverBubble({ fromKeyboard: openedFromKeyboard() })}
    >
      <Leaf className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
    </button>
  )
}
