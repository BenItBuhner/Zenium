import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Rect, UIState, WebAppInstallPrompt } from '@shared/types'
import { isInstallable } from '@shared/webApp'
import { useChromeSurface } from '@renderer/hooks/useChromeSurface'
import { cmd, run } from '@renderer/lib/api'
import { takeOfferedInstall } from '@renderer/lib/installOffer'
import { POPOVER_WIDTH, toRect } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { barOf } from '@renderer/lib/surfaces'
import { closeInstallSheet, uiStore } from '@renderer/lib/ui'
import { AppIcon } from '../phone/InstallSheet'
import { BusyButton, DesktopPopover, Footer, TitleBlock } from '../siteControls/primitives'
import { V2Button } from '../v2/controls'
import { ShortcutDialog } from './ShortcutDialog'

const TITLE_ID = 'zen-install-title'

/** The pill's Install chip (`SidebarTop.tsx`): what the popover hangs from. */
const CHIP = '[data-install-chip]'

function chip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(CHIP)
}

/** The chip and the pill around it, in window coordinates; null while the chip is not drawn. */
function chipRects(): { anchor: Rect | null; bar: Rect | null } {
  const el = chip()
  if (!el) return { anchor: null, bar: null }
  const r = el.getBoundingClientRect()
  if (r.width === 0) return { anchor: null, bar: null }
  return { anchor: toRect(r), bar: barOf(el) }
}

/**
 * The install surface of a host with windows (MW-22; the Design Lead's ruling on W8-M3's item
 * 3): registered with the core through `ui.surface`, so `webapp.openInstall` – the pill's Install
 * chip, the app menu's "Install <app>…", the core's own offer – knows a surface is mounted to
 * take the prompt, and never on a one-window host, whose surface is the phone sheet
 * (`InstallLayer`). A page with an installable manifest gets Chrome's form, the popover under the
 * chip; a page without one keeps the "Create shortcut" dialog (`ShortcutDialog.tsx`) until the
 * Lead rules on it.
 */
export function InstallPopoverLayer({ state }: { state: UIState }): JSX.Element | null {
  const desktop = state.capabilities.windows === true
  useChromeSurface('install', desktop)
  const prompt = uiStore.use((s) => s.install)
  if (!desktop || !prompt) return null
  return prompt.info && isInstallable(prompt.info) ? (
    <InstallPopover key={prompt.tabId} prompt={prompt} state={state} />
  ) : (
    <ShortcutDialog key={prompt.tabId} prompt={prompt} state={state} />
  )
}

/**
 * Chrome's install prompt in Chrome's form: a 320 popover (§9.20) hung from the pill's Install
 * chip, which keeps its pressed fill while the popover is up – the title block "Install <name>?"
 * (the app's name from its manifest, as the chip's own name is), the app's identity row (§9.23:
 * the tile beside the name and the origin) and the §9.11 footer, hugging and right-aligned,
 * Cancel then the one primary, Install. No scrim: the popover is light-dismissed (§9.20) – a
 * press outside it, a scroll away, Escape – and every dismissal, Cancel included, reports a
 * cancelled install to the core and folds the popover back into the chip (the pop reversed, as
 * a prompt beside its chip leaves); the chip stays, to open it again. Install runs the install
 * path of old – `webapp.pin` with the app's name – busy while the core has the host write the
 * launcher and leaving on the spring once the request has settled (the core toasts "Installed
 * <name>", or the failure).
 *
 * The keyboard (§9.22): a popover the user opened – the chip, the app menu – takes the first
 * control, and Escape hands the keyboard back to the chip it hung from; the popover the core's
 * offer opened of its own accord (`lib/installOffer.ts`) takes no focus, as a prompt raised
 * beside a chip does while the user is reading the page (§9.6), and leaves the keyboard where it
 * was when it goes. The popover belongs to the tab it was asked for and goes with it, cancelling
 * an install not yet taken.
 */
function InstallPopover({
  prompt,
  state
}: {
  prompt: WebAppInstallPrompt
  state: UIState
}): JSX.Element {
  // Asked once, as the popover mounts: the prompt is the offer's, or the user's.
  const [offered] = useState(() => takeOfferedInstall(prompt.tabId))
  const [rects, setRects] = useState(chipRects)
  // The popover follows the pill through a window resize rather than leaving (`follow`): the
  // chip is still there to hang from.
  useEffect(() => {
    const measure = (): void => setRects(chipRects())
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const accepted = useRef(false)
  // The popover leaves once, whichever of a dismissal, a button or its tab going says so.
  const left = useRef(false)

  const leave = (cancel: boolean): void => {
    if (left.current) return
    left.current = true
    if (cancel) {
      run('webapp.cancelInstall', { tabId: prompt.tabId })
      setCancelled(true)
    }
    setClosing(true)
  }
  const cancel = (): void => leave(true)
  const install = async (): Promise<void> => {
    if (accepted.current) return
    accepted.current = true
    setBusy(true)
    // Resolves once the request reached the launcher or could not be made (the core toasts the
    // failure); either way the popover is done.
    await cmd('webapp.pin', { tabId: prompt.tabId, title: prompt.title }).catch(() => undefined)
    leave(false)
  }

  // The tab the prompt was asked for is no longer this window's active one: closed, switched
  // away from, or – after Install – moved into the app's own window. An install not yet taken
  // is cancelled with it.
  const tab = activeTab(state)
  const gone = !tab || tab.id !== prompt.tabId
  useEffect(() => {
    if (gone) leave(!accepted.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the tab's change only
  }, [gone])

  return (
    <DesktopPopover
      anchor={rects.anchor}
      bar={rects.bar}
      width={POPOVER_WIDTH.list}
      labelledBy={TITLE_ID}
      closing={closing}
      collapse={rects.anchor !== null && cancelled}
      // Escape on a popover the user opened leaves the keyboard on the chip (`usePopover`'s
      // return); the offer's popover took none, so there is nothing to hand back.
      onClosed={(byKey) => closeInstallSheet(prompt.tabId, { keepFocus: byKey && !offered })}
      onDismiss={cancel}
      focus={offered ? 'none' : 'first'}
      follow
      anchorElement={chip}
      data-install-popover=""
      data-offered={offered ? '' : undefined}
    >
      {() => (
        <>
          <TitleBlock id={TITLE_ID} title={`Install ${prompt.title}?`} />
          <div className="zen-install-app px-4">
            <AppIcon icon={prompt.icon} name={prompt.title} tint={prompt.tint} size={48} />
            <div className="min-w-0 flex-1">
              <div className="zen-install-name truncate">{prompt.title}</div>
              <div className="zen-install-detail truncate">{prompt.origin}</div>
            </div>
          </div>
          <Footer count={2} hairline={false}>
            <V2Button disabled={busy} onClick={cancel}>
              Cancel
            </V2Button>
            <BusyButton variant="primary" data-accept="" busy={busy} onClick={() => void install()}>
              Install
            </BusyButton>
          </Footer>
        </>
      )}
    </DesktopPopover>
  )
}
