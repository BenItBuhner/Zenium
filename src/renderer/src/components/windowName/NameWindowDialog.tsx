import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { WINDOW_NAME_MAX } from '@shared/windowTitle'
import { run } from '@renderer/lib/api'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { closeNameWindow, uiStore } from '@renderer/lib/ui'
import { useEscapeTrap } from '../bookmarks/escape'
import { wrapTab } from '../bookmarks/popover'

/**
 * Chrome's Name window prompt (More tools › Name window…, the tab strip's row;
 * shortcuts-menus-121, -149, context-menus-108): a §9.23 dialog at §9.20's 400 – the `form`
 * width, a form's and a wrapping description's (at 288 the sentence under the title ran to three
 * lines; at 368 it is two, and the dialog 196 tall); #392's 320 is for a prompt over another
 * dialog, which this is not – on TabDialogs' `FrameDialogHost`, over the page's picture, while
 * `uiStore.nameWindowOpen` is set. One field holding the window's current name, focused and
 * selected so typing replaces it; Enter saves (an emptied field clears the name, as Chrome's
 * does), Escape and the scrim cancel, Tab wraps. The footer is the chassis's Cancel · Save at
 * 96 | 8 | 96 (§9.11's dialog footer, the settings dialogs' rule), not `.zen-bm-footer`'s
 * intrinsic widths. The answer is the core's `window.setName`; the title bar and tab search
 * follow from there.
 *
 * Built on the frame-dialog host with the same rules as W4-1's `ConfirmDialog` (container
 * focus, Enter as the default, one hop back to the page) – a candidate to move onto that export
 * once it lands.
 */
export function NameWindowDialog({ state }: { state: UIState }): JSX.Element | null {
  const open = uiStore.use((s) => s.nameWindowOpen)
  if (!open) return null
  return <NameWindowView key={state.window.id} current={state.window.name} />
}

function NameWindowView({ current }: { current: string | null }): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(current ?? '')

  useEffect(() => {
    fieldRef.current?.focus()
    fieldRef.current?.select()
  }, [])
  useEscapeTrap(true, closeNameWindow)
  useFrameDialog({ onScrimPress: closeNameWindow })

  const save = (): void => {
    const next = name.trim()
    run('window.setName', { name: next ? next : null })
    closeNameWindow()
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="zen-name-window-title"
      aria-describedby="zen-name-window-desc"
      data-name-window-dialog
      className="zen-animate-pop zen-bm-dialog flex max-w-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => wrapTab(e, dialogRef.current)}
    >
      <div className="zen-bm-title-block">
        <h2 id="zen-name-window-title" className="zen-bm-title">
          Name window
        </h2>
        <p id="zen-name-window-desc" className="zen-bm-title-desc">
          The name stands in the title bar and in tab search in place of the active tab’s title.
        </p>
      </div>
      <form
        className="zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <input
          ref={fieldRef}
          className="zen-field"
          aria-label="Window name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={WINDOW_NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          placeholder="Window name"
        />
        {/* The chassis's dialog footer: both buttons 96 wide at the least, the 8 between them. */}
        <div className="zen-bm-footer justify-end">
          <button type="button" className="zen-button min-w-[96px]" onClick={closeNameWindow}>
            Cancel
          </button>
          <button type="submit" className="zen-button min-w-[96px]" data-variant="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
