import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { UIState } from '@shared/types'
import { isNewTabUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { closeNewTabShortcutDialog, type UiState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useEscapeTrap } from '../bookmarks/escape'
import { wrapTab } from '../bookmarks/popover'
import { shortcutFormError } from './shortcutForm'

type ShortcutDialogRequest = NonNullable<UiState['newTabShortcutDialog']>

/**
 * The new tab page's "Add Shortcut" / "Edit Shortcut" dialog (Chrome's, with Name and URL). A
 * v2 dialog (design language v2 draft §9.23): a title block and no X; Escape, the scrim and the
 * footer close it; the name field takes focus and Tab wraps (§9.22); the fields carry their
 * label above them and the validation line below (§9.12). Rendered inside TabDialogs'
 * `FrameDialogHost` over the page's picture, so the dialog never sits inside the page.
 */
export function NewTabShortcutDialog({
  state,
  request
}: {
  state: UIState
  request: ShortcutDialogRequest
}): JSX.Element | null {
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(request.title)
  const [url, setUrl] = useState(request.url)
  const [touched, setTouched] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const editing = request.id !== null
  const shortcuts = state.newTabShortcuts

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // The dialog belongs to the page it was asked from: it goes with that page, and with a
  // shortcut that was removed (Settings, another window) while it was up.
  const tab = activeTab(state)
  const gone =
    !tab ||
    tab.id !== request.tabId ||
    !isNewTabUrl(tab.url) ||
    (editing && !shortcuts.some((s) => s.id === request.id))
  useEffect(() => {
    if (gone) closeNewTabShortcutDialog()
  }, [gone])
  useEscapeTrap(!gone, closeNewTabShortcutDialog)
  useFrameDialog({ onScrimPress: closeNewTabShortcutDialog, active: !gone })
  if (gone) return null

  const error = shortcutFormError(url, shortcuts, request.id)
  const shownError = touched && url.trim() ? error : null
  const save = (): void => {
    setTouched(true)
    if (error) return
    const title = name.trim()
    const address = url.trim()
    if (editing && request.id) run('newtab.updateShortcut', { id: request.id, title, url: address })
    else void run('newtab.addShortcut', { title, url: address })
    closeNewTabShortcutDialog()
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby="zen-ntp-shortcut-title"
      data-newtab-dialog={editing ? 'edit' : 'add'}
      className={cn(
        'zen-animate-pop zen-bm-dialog flex max-h-[calc(100%-24px)] flex-col',
        phone &&
          'mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto self-end justify-self-stretch'
      )}
      style={phone ? undefined : { width: POPOVER_WIDTH.form }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closeNewTabShortcutDialog()
          return
        }
        wrapTab(e, dialogRef.current)
      }}
    >
      <div className="zen-bm-title-block">
        <h2 id="zen-ntp-shortcut-title" className="zen-bm-title">
          {editing ? 'Edit Shortcut' : 'Add Shortcut'}
        </h2>
      </div>
      <form
        className="zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="zen-bm-label">
          Name
          <input
            ref={nameRef}
            className="zen-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="zen-bm-label">
          URL
          <input
            className="zen-field"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={shownError ? true : undefined}
            aria-describedby={shownError ? 'zen-ntp-shortcut-error' : undefined}
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            placeholder="example.com"
          />
          {shownError && (
            <span
              id="zen-ntp-shortcut-error"
              role="alert"
              className="flex items-center gap-2 text-[13px] leading-[20px] text-[var(--v2-danger)]"
            >
              <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {shownError}
            </span>
          )}
        </label>
        <div className="zen-bm-footer justify-end">
          <button type="button" className="zen-button" onClick={closeNewTabShortcutDialog}>
            Cancel
          </button>
          <button
            type="submit"
            className="zen-button"
            data-variant="primary"
            disabled={!url.trim() || Boolean(shownError)}
          >
            {editing ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  )
}
