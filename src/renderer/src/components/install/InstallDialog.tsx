import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState, WebAppInstallPrompt } from '@shared/types'
import { installSheetCopy } from '@shared/webApp'
import { useChromeSurface } from '@renderer/hooks/useChromeSurface'
import { usePopover } from '@renderer/hooks/usePopover'
import { cmd, run } from '@renderer/lib/api'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { closeInstallSheet, uiStore } from '@renderer/lib/ui'
import { V2Button, V2Field, V2FormField, V2TitleBlock } from '../extensions/v2'
import { AppIcon, ScreenshotStrip } from '../phone/InstallSheet'

const TITLE_ID = 'zen-install-dialog-title'
const NAME_FIELD_ID = 'zen-install-dialog-name'
/** Desktop shots are the wide ones; at this height a 16:9 shot is 320 wide, most of the 400. */
const SHOT_HEIGHT = 180

/**
 * The desktop's install prompt (MW-22), in the frame dialog host `TabDialogs` mounts: the install
 * surface of a host with windows (`ChromeSurface` – the core offers "Install app…" / "Create
 * shortcut…" in the app menu and holds a site's `prompt()` for a window only while this is up),
 * so the layer registers on those hosts alone; the phone's sheet (`phone/InstallSheet.tsx`) is
 * the surface on a one-window host and this layer never registers there.
 */
export function InstallDialogLayer({ state }: { state: UIState }): JSX.Element | null {
  const desktop = state.capabilities.windows
  useChromeSurface('install', desktop)
  const prompt = uiStore.use((s) => s.install)
  return desktop && prompt ? (
    <InstallDialog key={prompt.tabId} prompt={prompt} state={state} />
  ) : null
}

/**
 * Chrome's install dialog as a `--v2-dialog` at the form width (§9.20) over the host's scrim: a
 * title block (§9.23; "Install app" for a page with an installable manifest, "Create shortcut"
 * otherwise – Chrome's two titles, in sentence case), then the app – its 48 tile beside its name
 * and origin, the manifest's description clamped to four lines and its wide screenshots as a
 * strip, as Chrome's detailed install dialog shows them – or, for a page without a manifest, the
 * page's tile beside a labelled name field (§9.12) with the origin as its description, as
 * Chrome's "Create shortcut" lets the name be edited. The §9.11 footer hugs and right-aligns:
 * Cancel, then the one primary (§9.33) – "Install" / "Create" – which goes busy (§9.30) while
 * the core has the host write the launcher; the dialog leaves once the request has reached it
 * (the core toasts "Installed <name>" and moves the tab into the app's own window) or failed
 * (the core toasts that). Escape, the scrim and Cancel report a cancelled install so a site's
 * deferred `prompt()` learns of it; there is no X. Focus starts on the name field when there is
 * one, else on the primary, and Tab wraps (§9.22). The dialog belongs to the tab it was asked
 * from and goes with it.
 */
function InstallDialog({
  prompt,
  state
}: {
  prompt: WebAppInstallPrompt
  state: UIState
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(prompt.title)
  const [busy, setBusy] = useState(false)
  const accepted = useRef(false)
  // The dialog leaves once, whichever of Escape, the scrim, a button or its tab going says so.
  const left = useRef(false)
  const info = prompt.info
  const copy = installSheetCopy(prompt.surface, info)
  const name = title.trim() || prompt.title

  const leave = (cancelled: boolean): void => {
    if (left.current) return
    left.current = true
    if (cancelled) run('webapp.cancelInstall', { tabId: prompt.tabId })
    closeInstallSheet(prompt.tabId)
  }
  const cancel = (): void => leave(true)
  const install = async (): Promise<void> => {
    if (accepted.current) return
    accepted.current = true
    setBusy(true)
    // Resolves once the request reached the launcher or could not be made (the core toasts the
    // failure); either way the dialog is done.
    await cmd('webapp.pin', { tabId: prompt.tabId, title: name }).catch(() => undefined)
    leave(false)
  }

  // The tab the prompt was asked from is no longer this window's active one: closed, switched
  // away from, or – after "Install" – moved into the app's own window. An install not yet taken
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
      data-install-dialog={info ? 'app' : 'shortcut'}
      className="zen-v2 zen-v2-dialog zen-animate-pop zen-install-dialog flex max-h-[calc(100%-32px)] max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
    >
      <V2TitleBlock id={TITLE_ID} title={copy.title} />
      <div className="zen-install-dialog-body">
        <div className="zen-install-app">
          <AppIcon icon={prompt.icon} name={name} tint={prompt.tint} size={48} />
          {info ? (
            <div className="min-w-0 flex-1">
              <div className="zen-install-name truncate">{info.name}</div>
              <div className="zen-install-detail truncate">{prompt.origin}</div>
            </div>
          ) : (
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
                      void install()
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
          )}
        </div>
        {info?.description && <p className="zen-install-description">{info.description}</p>}
        {info && info.screenshots.length > 0 && (
          <ScreenshotStrip shots={info.screenshots} formFactor="wide" height={SHOT_HEIGHT} />
        )}
      </div>
      <div className="zen-install-dialog-footer">
        <V2Button disabled={busy} onClick={cancel}>
          Cancel
        </V2Button>
        <V2Button
          variant="primary"
          data-accept=""
          data-initial={info ? '' : undefined}
          busy={busy}
          onClick={() => void install()}
        >
          {copy.action}
        </V2Button>
      </div>
    </div>
  )
}
