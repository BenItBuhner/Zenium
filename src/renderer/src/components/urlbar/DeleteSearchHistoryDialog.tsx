import type { JSX } from 'react'
import { Trash2 } from 'lucide-react'
import { closeDeleteSearchHistoryConfirm, confirmDeleteSearchHistory } from '@renderer/lib/ui'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'

/** The desktop bar's field: where the keyboard goes back to as the prompt leaves (§9.5). */
const OMNIBOX_FIELD = '.zen-omnibox-input'

/**
 * "Delete search history?" (context-menus-115's second menu row; §10.5's bulk case, pr-434
 * ruling 3): the §9.23 confirmation (`ConfirmDialog`) – the question at 17/600 with the trash
 * glyph, one paragraph at 15 in the deemphasised ink on what goes and what stays, then Cancel
 * and the danger verb, no primary (§6) – at §9.20's 320 over the open bar and the page's
 * picture, centred in the content frame under the frame's scrim (§9.5), through TabDialogs'
 * `FrameDialogHost`. The row's neighbour, Remove, asks nothing: one row goes, and the core's
 * removes bring it back as a fresh visit would. Delete forgets every search the address bar
 * remembered and takes their rows out of the open list (`confirmDeleteSearchHistory`); the
 * browsing history stays. Cancel, Escape and the scrim change nothing.
 *
 * The keyboard is the primitive's (§9.22 as amended on #392): the prompt holds its container,
 * Tab enters at Cancel, Shift+Tab at Delete; a destructive prompt has no default, so Enter from
 * the held container answers nothing – only a focused Delete's own Enter or Space deletes. The
 * bar stays up under the prompt, inert with the frame, and the keyboard comes back to its field
 * whichever way the prompt is answered – the caret where the right-click left it, the highlight
 * on its row or on the row that took a deleted row's place (`Urlbar`'s `dropRows`) – once the
 * frame's `inert` lifts (lib/popover.ts `returnFocusTo`). Should the bar have gone under the
 * prompt, the return falls to the primitive's opener and then to the page
 * (`closeDeleteSearchHistoryConfirm`).
 */
export function DeleteSearchHistoryDialog(): JSX.Element {
  return (
    <ConfirmDialog
      name="delete-search-history"
      title="Delete search history?"
      glyph={<Trash2 strokeWidth={1.5} aria-hidden />}
      description="Every search Zenium remembered for the address bar is forgotten. Your browsing history stays."
      action="Delete"
      destructive
      onCancel={closeDeleteSearchHistoryConfirm}
      onConfirm={confirmDeleteSearchHistory}
      returnFocus={() => document.querySelector<HTMLElement>(OMNIBOX_FIELD)}
    />
  )
}
