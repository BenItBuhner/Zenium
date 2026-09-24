import type { JSX, ReactNode } from 'react'
import { ArrowRight, BookOpenText, Download, Languages, SquarePlay, Star } from 'lucide-react'
import { resolveDownloadSettings } from '@shared/downloads'
import { toolbarPinned, withToolbarPin, type ToolbarControl } from '@shared/toolbarPins'
import type { Settings, UIState } from '@shared/types'
import { hiddenAtThisWidth, toolbarTiering } from '@renderer/lib/toolbarPins'
import { V2Button } from '../../extensions/v2'
import { SheetFooter } from './blocks'
import type { SwitchRow } from './model'
import { RowView, type RowContext } from './rows'

/**
 * Look and Feel › Customise toolbar (settings-36; Chrome's pinnable toolbar actions, Firefox's
 * Customize): the body of the 400 form dialog the row opens (`FormSheet.body: 'list'` – the
 * title block over a list, the footer form under it, design language v2 §9.20). The lead's
 * spec (§10.5): §6's desktop checkbox form, one 32 row per optional control in the bar's own
 * order – Forward, then the pill's chips left to right, then the media hub and the downloads
 * button – each row leading with the control's 16 glyph after the box; checked = in the bar,
 * unchecked = folded into the app menu, whose row for the control is what runs it then. The
 * address pill, Back, Reload and the ⋯ menu are the bar, not its options, and have no row.
 * No preview: the bar over the dialog is the preview and every change applies as it is made.
 * A control the window's width has tiered away (§9.29, `toolbarTiering`) stays checked and
 * says "Hidden at this width." as its 13/69 % description, never disabled; a control the page
 * has to earn (an article's Reader View, media playing, a download running) says when it
 * shows. A row's description is the same in both of its states, so a toggle never moves the
 * rows under the pointer (§9.2: a row keeps its height). The footer is Done alone, a hugging
 * 32 secondary – nothing to cancel, nothing was held back. No reorder: the bar keeps the order
 * the rows show. "Pin" and "unpin" are Chrome's words for the box's two states and are not
 * drawn.
 *
 * The rows are the chassis's own: switch rows (`model.ts`) drawn in the desktop vocabulary
 * (`rows.tsx`'s check row – the 16 box left, the row its label, a press anywhere toggles) with
 * the control's glyph in the row's `leading` slot between the box and the label (#419, the
 * W4-10 ask), so the rows measure and paint as every other check row does and drift with it.
 *
 * The downloads button's pin is the existing `downloads.alwaysShowButton` (Chrome's "Always
 * show downloads button", also Settings › Downloads' switch): one field, bound here as its
 * Downloads row. Unchecked, the button is not folded into the menu as the others are – it
 * still comes with the session's first download (`downloadButtonVisible`), which is what the
 * row's line says. The rest write `Settings.toolbarPins` (`shared/toolbarPins.ts`).
 */
export function CustomizeToolbarForm({
  state,
  set,
  close
}: {
  state: UIState
  set(patch: Partial<Settings>): void
  close(): void
}): JSX.Element {
  const pins = state.settings.toolbarPins
  const hidden = toolbarTiering.use((s) => s.hidden)
  const downloads = resolveDownloadSettings(state.settings)
  const pin = (control: ToolbarControl, pinned: boolean): void =>
    set({ toolbarPins: withToolbarPin(pins, control, pinned) })
  const controlRow = (
    control: ToolbarControl,
    label: string,
    leading: ReactNode,
    description?: string
  ): SwitchRow => ({
    kind: 'switch',
    id: `toolbar-control:${control}`,
    label,
    leading,
    checked: toolbarPinned(pins, control),
    description:
      toolbarPinned(pins, control) && hiddenAtThisWidth(hidden, control)
        ? HIDDEN_AT_THIS_WIDTH
        : description,
    onChange: (checked) => pin(control, checked)
  })
  const rows: SwitchRow[] = [
    controlRow('forward', 'Forward', <ArrowRight />),
    controlRow('reader', 'Reader View', <BookOpenText />, 'Shows on pages with an article.'),
    controlRow('translate', 'Translate', <Languages />),
    controlRow('star', 'Bookmark this page', <Star />),
    controlRow('media', 'Media', <SquarePlay />, 'Shows while media plays.'),
    {
      kind: 'switch',
      id: 'toolbar-control:downloads',
      label: 'Downloads',
      leading: <Download />,
      checked: downloads.alwaysShowButton,
      description: DOWNLOADS_UNCHECKED,
      onChange: (checked) => set({ downloads: { alwaysShowButton: checked } })
    }
  ]
  return (
    <>
      <div className="zen-settings-groups zen-settings-sheet-rows" data-testid="customize-toolbar">
        <section role="group" className="zen-settings-group" aria-label="Toolbar controls">
          {rows.map((row) => (
            <RowView key={row.id} row={row} ctx={NO_SHEETS} variant="desktop" />
          ))}
        </section>
      </div>
      <SheetFooter>
        <V2Button data-testid="customize-toolbar-done" onClick={close}>
          Done
        </V2Button>
      </SheetFooter>
    </>
  )
}

/** The lead's description for a pinned control the width tier has folded (§9.29). */
export const HIDDEN_AT_THIS_WIDTH = 'Hidden at this width.'

/**
 * The Downloads row's line in both states: unchecked, the button is not in the menu as the
 * other folded controls are – it comes with the first download (Chrome's rule) – and the line
 * says so whether the box is checked or not, so the row keeps its 52 across a toggle.
 */
export const DOWNLOADS_UNCHECKED = 'Unchecked, shows once a download starts.'

/**
 * A check row toggles in place and asks the page for no sheet; the rows' context has nothing to
 * open (the dialog they stand in is the page's, opened by the Customise toolbar row itself).
 */
const NO_SHEETS: RowContext = { open: () => undefined }
