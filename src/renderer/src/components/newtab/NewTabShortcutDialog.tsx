import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { NewTabShortcut, UIState } from '@shared/types'
import { isEmptyTabUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { closeNewTabShortcutDialog, type UiState } from '@renderer/lib/ui'
import { useEscapeTrap } from '../bookmarks/escape'
import { wrapTab } from '../bookmarks/popover'
import { Field, SheetActions, ValidationMessage } from '../pages/settings/blocks'
import { SettingsSheet } from '../pages/settings/sheets'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { shortcutFormError } from './shortcutForm'

type ShortcutDialogRequest = NonNullable<UiState['newTabShortcutDialog']>

/**
 * The new tab page's "Add shortcut" / "Edit shortcut" form (Chrome's, with Name and URL; the
 * title in sentence case, §9.1), rendered inside TabDialogs' `FrameDialogHost` over the page's
 * picture, so it never sits inside the page. Two chassis for the one form:
 *  - on the desktop a v2 dialog (design language v2 draft §9.23): a title block and no X;
 *    Escape, the scrim and the footer close it; the name field takes focus and Tab wraps
 *    (§9.22); the fields carry their label above them and the validation line below (§9.12);
 *  - on a phone the form sheet the Settings Address row opens (`SettingsSheet`, the chassis of
 *    §9.16 and §9.12: the grip, the 48 centred header naming the form, the 16 gutter, Cancel |
 *    Save splitting the footer's width at 40, the sheet itself focused as it opens so the
 *    keyboard waits for a tap on a field). The labels stay: "Edit shortcut" over Name and URL
 *    says nothing a label says (§9.12's one-field rule is the Address sheet's).
 *
 * The form belongs to the page it was asked from: it goes with that page, and with a shortcut
 * that was removed (Settings, another window) while it was up.
 */
export function NewTabShortcutDialog({
  state,
  request
}: {
  state: UIState
  request: ShortcutDialogRequest
}): JSX.Element | null {
  const phone = useViewport().formFactor === 'phone'
  const editing = request.id !== null
  const shortcuts = state.newTabShortcuts

  // The page is the served `zen://newtab` on the desktop and the blank tab the phone's chrome
  // draws its page over (NewTabPage.tsx), so either counts as the page being there.
  const tab = activeTab(state)
  const gone =
    !tab ||
    tab.id !== request.tabId ||
    !isEmptyTabUrl(tab.url) ||
    (editing && !shortcuts.some((s) => s.id === request.id))
  useEffect(() => {
    if (gone) closeNewTabShortcutDialog()
  }, [gone])
  if (gone) return null

  return phone ? (
    <ShortcutSheet request={request} shortcuts={shortcuts} />
  ) : (
    <ShortcutDialog request={request} shortcuts={shortcuts} />
  )
}

/** The form's fields and their commit, shared by the two chassis. */
function useShortcutForm(
  request: ShortcutDialogRequest,
  shortcuts: NewTabShortcut[]
): {
  name: string
  setName(name: string): void
  url: string
  setUrl(url: string): void
  touch(): void
  /** The URL's validation message while it is shown (the field touched and not empty). */
  shownError: string | null
  /** Nothing to save yet: an empty URL or one the message refuses. */
  blocked: boolean
  /** Marks the URL touched; the commit that writes the shortcut, or null while it cannot. */
  save(): (() => void) | null
} {
  const editing = request.id !== null
  const [name, setName] = useState(request.title)
  const [url, setUrl] = useState(request.url)
  const [touched, setTouched] = useState(false)
  const error = shortcutFormError(url, shortcuts, request.id)
  const shownError = touched && url.trim() ? error : null
  return {
    name,
    setName,
    url,
    setUrl,
    touch: () => setTouched(true),
    shownError,
    blocked: !url.trim() || Boolean(shownError),
    save: () => {
      setTouched(true)
      if (error) return null
      const title = name.trim()
      const address = url.trim()
      const id = request.id
      return editing && id
        ? () => run('newtab.updateShortcut', { id, title, url: address })
        : () => run('newtab.addShortcut', { title, url: address })
    }
  }
}

/** The desktop's v2 dialog (§9.23). */
function ShortcutDialog({
  request,
  shortcuts
}: {
  request: ShortcutDialogRequest
  shortcuts: NewTabShortcut[]
}): JSX.Element {
  const form = useShortcutForm(request, shortcuts)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const editing = request.id !== null

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])
  useEscapeTrap(true, closeNewTabShortcutDialog)
  useFrameDialog({ onScrimPress: closeNewTabShortcutDialog, active: true })

  const save = (): void => {
    const commit = form.save()
    if (!commit) return
    commit()
    closeNewTabShortcutDialog()
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby="zen-ntp-shortcut-title"
      data-newtab-dialog={editing ? 'edit' : 'add'}
      className="zen-animate-pop zen-bm-dialog flex max-h-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
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
          {editing ? 'Edit shortcut' : 'Add shortcut'}
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
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
            maxLength={120}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="zen-bm-label">
          URL
          <input
            className="zen-field"
            value={form.url}
            onChange={(e) => form.setUrl(e.target.value)}
            onBlur={form.touch}
            aria-invalid={form.shownError ? true : undefined}
            aria-describedby={form.shownError ? 'zen-ntp-shortcut-error' : undefined}
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            placeholder="example.com"
          />
          {form.shownError && (
            <span
              id="zen-ntp-shortcut-error"
              role="alert"
              className="flex items-center gap-2 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-danger)]"
            >
              <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {form.shownError}
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
            disabled={form.blocked}
          >
            {editing ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * The phone's form sheet: the Address sheet's chassis (`SettingsSheet` → `PhoneSheet`, the 48
 * header naming the form), `.zen-settings-form` with the two labelled fields (§9.12) and
 * `SheetActions` – Cancel | Save (Add) splitting the width (§9.11). Every way out slides the
 * sheet away first; the commit runs once it is gone, like a picked menu row, and the request
 * clears with `onClose`. The sheet takes the focus as it opens (§9.22: a text field never does
 * on a phone, the keyboard would come up with the sheet); a tap on a field brings it.
 */
function ShortcutSheet({
  request,
  shortcuts
}: {
  request: ShortcutDialogRequest
  shortcuts: NewTabShortcut[]
}): JSX.Element {
  const form = useShortcutForm(request, shortcuts)
  const sheet = useRef<BottomSheetHandle>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const urlId = useId()
  // The URL's validation line, named by the field (`aria-describedby`) while it shows, as the
  // desktop dialog names `zen-ntp-shortcut-error`.
  const urlErrorId = `${urlId}-error`
  const editing = request.id !== null
  const dismiss = (then?: () => void): void => sheet.current?.dismiss(then)

  const save = (): void => {
    const commit = form.save()
    if (commit) dismiss(commit)
  }

  return (
    <SettingsSheet
      name="newtab-shortcut"
      title={editing ? 'Edit shortcut' : 'Add shortcut'}
      focus="dialog"
      under={false}
      onClose={closeNewTabShortcutDialog}
      sheetRef={sheet}
    >
      <div className="zen-settings-form" data-newtab-dialog={editing ? 'edit' : 'add'}>
        <Field id={nameId} label="Name">
          <input
            id={nameId}
            className="zen-settings-input zen-v2-field"
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
            onKeyDown={(e) => {
              // The keyboard's Next: on to the URL, as the hint says.
              if (e.key !== 'Enter') return
              e.preventDefault()
              urlRef.current?.focus()
            }}
            maxLength={120}
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="next"
          />
        </Field>
        <Field id={urlId} label="URL">
          <input
            ref={urlRef}
            id={urlId}
            className="zen-settings-input zen-v2-field"
            value={form.url}
            onChange={(e) => form.setUrl(e.target.value)}
            onBlur={form.touch}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (!form.blocked) save()
            }}
            aria-invalid={form.shownError ? true : undefined}
            aria-describedby={form.shownError ? urlErrorId : undefined}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            enterKeyHint="done"
            placeholder="example.com"
          />
          {form.shownError && <ValidationMessage id={urlErrorId} message={form.shownError} />}
        </Field>
        <SheetActions
          action={editing ? 'Save' : 'Add'}
          disabled={form.blocked}
          onCancel={() => dismiss()}
          onAction={save}
        />
      </div>
    </SettingsSheet>
  )
}
