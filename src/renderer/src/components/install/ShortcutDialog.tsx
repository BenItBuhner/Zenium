import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState, WebAppInstallPrompt } from '@shared/types'
import { installSheetCopy } from '@shared/webApp'
import { usePopover } from '@renderer/hooks/usePopover'
import { cmd, run } from '@renderer/lib/api'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { closeInstallSheet } from '@renderer/lib/ui'
import { V2Button, V2CheckRow, V2Field, V2FormField, V2TitleBlock } from '../extensions/v2'
import { AppIcon } from '../phone/InstallSheet'

const TITLE_ID = 'zen-install-dialog-title'
const NAME_FIELD_ID = 'zen-install-dialog-name'

/**
 * Chrome's "Create shortcut" dialog for a page without an installable manifest (MW-22; the app
 * menu's "Create Shortcut…"), as a `--v2-dialog` at the form width (§9.20) over the host's scrim
 * in the frame dialog host `TabDialogs` mounts – a §9.5 frame dialog in Chrome's wording, the
 * Design Lead's gate on #754 (§10): the title block (§9.23) "Create shortcut?", then the page's
 * tile beside a labelled name field (§9.12) pre-filled with the page's title, the origin as its
 * description, as Chrome lets the name be edited; under it Chrome's "Open as window" check row
 * (§9.23), unchecked as Chrome leaves it. The §9.11 footer hugs and right-aligns: Cancel, then
 * the one primary (§9.33) – "Create" – which goes busy (§9.30) while the core has the host write
 * the launcher; the dialog leaves once the request has reached it (the core toasts "Shortcut
 * created") or failed (the core toasts that). Escape, the scrim and Cancel report a cancelled
 * install; there is no X. Focus starts on the name field – a form, not a confirm, so §5.7's
 * container focus is not this dialog's – and Tab wraps (§9.22). The dialog belongs to the tab
 * it was asked from and goes with it.
 *
 * The box's two states travel with Create (W8-M3b, the Design Lead's ruling on the #754 seams):
 * `webapp.pin` carries `openAsWindow` – checked, the launcher the host writes runs `zenium
 * --app=<url>` and the shortcut opens in an app window of its own, and the page moves into that
 * window at once, as Chrome moves the tab (W8-M3c, seed D5); unchecked, Chrome's default, it
 * runs `zenium <url>` and the page opens as a tab in Zenium's current window (the
 * second-instance path a `zenium <url>` from a shell takes), and the tab stays. The core keeps
 * the shortcut on record with the mode (`PinnedWebApp.kind` `shortcut`), so Settings › Apps
 * lists it and its Open opens it the way the launcher does.
 *
 * The install of a page WITH an installable manifest is the pill's Install chip and its popover
 * (`InstallPopover.tsx`, the Design Lead's ruling on W8-M3's item 3); it installs an app, always
 * in a window of its own, and sends no box.
 */
export function ShortcutDialog({
  prompt,
  state
}: {
  prompt: WebAppInstallPrompt
  state: UIState
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(prompt.title)
  // Chrome's default: a shortcut opens in a tab unless the user asks for a window.
  const [openAsWindow, setOpenAsWindow] = useState(false)
  const [busy, setBusy] = useState(false)
  const accepted = useRef(false)
  // The dialog leaves once, whichever of Escape, the scrim, a button or its tab going says so.
  const left = useRef(false)
  const copy = installSheetCopy(prompt.surface, prompt.info)
  const name = title.trim() || prompt.title

  const leave = (cancelled: boolean): void => {
    if (left.current) return
    left.current = true
    if (cancelled) run('webapp.cancelInstall', { tabId: prompt.tabId })
    closeInstallSheet(prompt.tabId)
  }
  const cancel = (): void => leave(true)
  const create = async (): Promise<void> => {
    if (accepted.current) return
    accepted.current = true
    setBusy(true)
    // Resolves once the request reached the launcher or could not be made (the core toasts the
    // failure); either way the dialog is done.
    await cmd('webapp.pin', { tabId: prompt.tabId, title: name, openAsWindow }).catch(
      () => undefined
    )
    leave(false)
  }

  // The tab the prompt was asked from is no longer this window's active one: closed, switched
  // away from, or – after "Create" – moved into the app's own window. A shortcut not yet taken
  // is cancelled with it.
  const tab = activeTab(state)
  const gone = !tab || tab.id !== prompt.tabId
  useEffect(() => {
    if (gone) leave(!accepted.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the tab's change only
  }, [gone])

  useFrameDialog({ onScrimPress: cancel })
  usePopover(ref, {
    onClose: cancel,
    initial: (root) => root.querySelector<HTMLElement>('[data-initial]'),
    returnTo: null
  })

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      data-install-dialog="shortcut"
      className="zen-v2 zen-v2-dialog zen-animate-pop zen-install-dialog flex max-h-[calc(100%-32px)] max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
    >
      <V2TitleBlock id={TITLE_ID} title="Create shortcut?" />
      <div className="zen-install-dialog-body">
        <div className="zen-install-app">
          <AppIcon icon={prompt.icon} name={name} tint={prompt.tint} size={48} />
          <V2FormField
            id={NAME_FIELD_ID}
            label="Name"
            description={prompt.origin}
            className="min-w-0 flex-1"
          >
            {(field) => (
              <V2Field
                {...field}
                data-initial=""
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void create()
                  }
                }}
                maxLength={60}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={prompt.title}
              />
            )}
          </V2FormField>
        </div>
        <V2CheckRow
          label="Open as window"
          checked={openAsWindow}
          disabled={busy}
          onChange={setOpenAsWindow}
        />
      </div>
      <div className="zen-install-dialog-footer">
        <V2Button disabled={busy} onClick={cancel}>
          Cancel
        </V2Button>
        <V2Button variant="primary" data-accept="" busy={busy} onClick={() => void create()}>
          {copy.action}
        </V2Button>
      </div>
    </div>
  )
}
