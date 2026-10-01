import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Rect, UIState, WebAppInstallPrompt } from '@shared/types'
import { useChromeSurface } from '@renderer/hooks/useChromeSurface'
import { cmd, run } from '@renderer/lib/api'
import { BAND_CLOCK_RESUME_FLOOR_MS } from '@renderer/lib/band'
import { closeInstallOffer } from '@renderer/lib/installOffer'
import { BAND_CLOCK_MS } from '@renderer/lib/motion/tokens'
import { POPOVER_WIDTH, toRect } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { barOf } from '@renderer/lib/surfaces'
import {
  claimBannerSurface,
  closeInstallSheet,
  installPromptIsPopover,
  uiStore,
  type InstallOffer
} from '@renderer/lib/ui'
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
 * chip, the app menu's "Install <app>…" – knows a surface is mounted to take the prompt, and
 * never on a one-window host, whose surface is the phone sheet (`InstallLayer`). It is the
 * desktop's surface for the core's install banner too (`claimBannerSurface`: the word that the
 * card is drawn goes while it is mounted, `lib/installOffer.ts`), the banner's form being the
 * same popover, opened of its own accord. A page with an installable manifest gets Chrome's
 * form, the popover under the chip (`installPopoverUp`, the reading the content's dim shares:
 * no scrim under a popover); a page without one keeps the "Create shortcut" dialog
 * (`ShortcutDialog.tsx`) until the Lead rules on it. The prompt comes first: an offer up gives
 * way to it (`openInstallSheet`).
 */
export function InstallPopoverLayer({ state }: { state: UIState }): JSX.Element | null {
  const desktop = state.capabilities.windows === true
  useChromeSurface('install', desktop)
  useEffect(() => (desktop ? claimBannerSurface() : undefined), [desktop])
  const prompt = uiStore.use((s) => s.install)
  const offer = uiStore.use((s) => s.installOffer)
  if (!desktop) return null
  if (prompt) {
    return installPromptIsPopover(prompt) ? (
      <InstallPopover
        key={`prompt:${prompt.tabId}`}
        subject={{ kind: 'prompt', prompt }}
        state={state}
      />
    ) : (
      <ShortcutDialog key={prompt.tabId} prompt={prompt} state={state} />
    )
  }
  if (offer) {
    return (
      <InstallPopover
        key={`offer:${offer.banner.tabId}`}
        subject={{ kind: 'offer', offer }}
        state={state}
      />
    )
  }
  return null
}

/**
 * What the popover is up for: the prompt the user asked for (the chip, the app menu, the page's
 * own `prompt()`), or the core's offer (`lib/installOffer.ts`).
 */
type Subject =
  { kind: 'prompt'; prompt: WebAppInstallPrompt } | { kind: 'offer'; offer: InstallOffer }

/** The identity the popover shows for either subject: the app's name, its origin and its tile. */
function cardOf(
  subject: Subject
): Pick<WebAppInstallPrompt, 'tabId' | 'title' | 'origin' | 'icon' | 'tint'> {
  if (subject.kind === 'prompt') return subject.prompt
  const { tabId, name, origin, icon, tint } = subject.offer.banner
  return { tabId, title: name, origin, icon, tint }
}

/** How the popover went by the user's hand: Cancel, a light dismissal (the tab leaving too), Install. */
type Ending = 'cancel' | 'dismiss' | 'install'

/** The popover's root in the chrome layer (`data-install-popover`), while one is up. */
const ROOT = '[data-install-popover]'

/** Whether the pointer rests on `el` already as its clock arms (a popover opening under it). */
function hovered(el: Element): boolean {
  try {
    return el.matches(':hover')
  } catch {
    return false
  }
}

/**
 * The offer's clock (motion spec §3.2, §10 – the Lead's Q10 as amended): the popover the core's
 * offer opened stands `BAND_CLOCK_MS`, the page-edge band's one offer clock, kept here in the
 * host. Armed at the show; paused while the pointer is over the popover or the keyboard is
 * inside it – the user is reading it or acting on it – and resumed with what was left once both
 * have gone, at least the band's moment (`BAND_CLOCK_RESUME_FLOOR_MS`, the house's rule for a
 * message let go); run out, `expire` – the light dismissal's leave. The popover the user opened
 * has no clock (`armed` false): it stays until the focus leaves it. The core's own clock behind
 * `webapp.bannerHide` retires with #735; until it does it may still take a popover down.
 */
function useOfferClock(armed: boolean, expire: () => void): void {
  const latest = useRef(expire)
  useLayoutEffect(() => {
    latest.current = expire
  })
  useEffect(() => {
    if (!armed) return
    const el = document.querySelector<HTMLElement>(ROOT)
    if (!el) return
    let left = BAND_CLOCK_MS
    let started = false
    let due = 0
    let timer: number | null = null
    let over = hovered(el)
    let focused = el.contains(document.activeElement)
    const sync = (): void => {
      if (over || focused) {
        if (timer === null) return
        window.clearTimeout(timer)
        timer = null
        left = Math.max(0, due - Date.now())
        return
      }
      if (timer !== null) return
      const ms = started ? Math.max(left, BAND_CLOCK_RESUME_FLOOR_MS) : left
      started = true
      due = Date.now() + ms
      timer = window.setTimeout(() => {
        timer = null
        latest.current()
      }, ms)
    }
    const enter = (): void => {
      over = true
      sync()
    }
    const leave = (): void => {
      over = false
      sync()
    }
    const focusIn = (): void => {
      focused = true
      sync()
    }
    const focusOut = (event: FocusEvent): void => {
      focused = event.relatedTarget instanceof Node && el.contains(event.relatedTarget)
      sync()
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('focusin', focusIn)
    el.addEventListener('focusout', focusOut)
    sync()
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('focusin', focusIn)
      el.removeEventListener('focusout', focusOut)
    }
  }, [armed])
}

/**
 * Chrome's install prompt in Chrome's form: a 320 popover (§9.20) hung from the pill's Install
 * chip, which keeps its pressed fill while the popover is up – the title block "Install <name>?"
 * (the app's name from its manifest, as the chip's own name is), the app's identity row (§9.23:
 * the tile beside the name and the origin – the whole body, Chrome's simple bubble, nothing of
 * the manifest's description or screenshots; the phone's sheet keeps its strip of shots) and
 * the §9.11 footer, hugging and right-aligned, Cancel then the one primary, Install (the order
 * the Design Lead's gate on #754 confirmed, §10). No scrim: the popover is light-dismissed
 * (§9.20) – a press outside it, a scroll away, Escape – and every dismissal, Cancel included,
 * folds the popover back into the chip (the pop reversed, as a prompt beside its chip leaves);
 * the chip stays, to open it again. Install runs the install path of old – `webapp.pin` with
 * the app's name – busy while the core has the host write the launcher and leaving on the
 * spring once the request has settled (the core toasts "Installed <name>", or the failure).
 *
 * What the core hears is the subject's. For the user's prompt every dismissal, Cancel included,
 * is a cancelled install (`webapp.cancelInstall`). For the core's offer the popover is the
 * banner's card, and it answers as the phone's does: Cancel is the card's swipe
 * (`webapp.dismissBanner` 'swipe' – the refusal, whose cooldown is the longer one); a light
 * dismissal, Escape, the tab leaving, the popover's leave after Install, and its own clock
 * running out are the clock running out ('timeout' – the stamp stands, nothing refused); the
 * core's own take-down (`retired`, `webapp.bannerHide`: the page left the app's scope or
 * changed document, the install opened through the menu, the app installed, a card undrawn)
 * sends nothing back. The offer's clock is the band's (`useOfferClock`: `BAND_CLOCK_MS`, armed
 * at the show, waiting under the pointer and the keyboard, resuming with the time left), and
 * the user's prompt has none.
 *
 * The keyboard (§9.22, §5.7): a popover the user opened – the chip, the app menu – focuses
 * Install, the primary – the user's act was the intent and Enter completes it, as Chrome does –
 * and Escape hands the keyboard back to the chip it hung from; the popover the core's offer
 * opened of its own accord takes no focus, as a prompt raised beside a chip does while the user
 * is reading the page (§9.6), and leaves the keyboard where it was when it goes. The
 * popover belongs to the tab it was asked for and goes with it, cancelling an install not yet
 * taken.
 */
function InstallPopover({ subject, state }: { subject: Subject; state: UIState }): JSX.Element {
  const offered = subject.kind === 'offer'
  const { tabId, title, origin, icon, tint } = cardOf(subject)
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
  const [folded, setFolded] = useState(false)
  const accepted = useRef(false)
  // The popover leaves once, whichever of a dismissal, a button or its tab going says so.
  const left = useRef(false)
  // The core took the offer's banner back (`lib/installOffer.ts` `retireInstallOffer`): the
  // popover leaves on the spring with nothing to report, and no ending of the user's after it.
  const retired = uiStore.use(
    (s) => offered && s.installOffer?.banner.tabId === tabId && s.installOffer.retired
  )

  const report = (ending: Ending): void => {
    if (!offered) {
      if (ending !== 'install') run('webapp.cancelInstall', { tabId })
      return
    }
    run('webapp.dismissBanner', { tabId, reason: ending === 'cancel' ? 'swipe' : 'timeout' })
  }
  const leave = (ending: Ending): void => {
    if (left.current || retired) return
    left.current = true
    report(ending)
    // A dismissal folds back into the chip; Install leaves on the spring.
    if (ending !== 'install') setFolded(true)
    setClosing(true)
  }
  const cancel = (): void => leave('cancel')
  const dismiss = (): void => leave('dismiss')
  // The offer's clock runs while the popover stands for the offer and nothing has ended it:
  // Install pressed, the core's take-down or a leave under way stop it.
  useOfferClock(offered && !busy && !closing && !retired, dismiss)
  const install = async (): Promise<void> => {
    if (accepted.current) return
    accepted.current = true
    setBusy(true)
    // Resolves once the request reached the launcher or could not be made (the core toasts the
    // failure); either way the popover is done.
    await cmd('webapp.pin', { tabId, title }).catch(() => undefined)
    leave('install')
  }

  // The tab the popover was asked for is no longer this window's active one: closed, switched
  // away from, or – after Install – moved into the app's own window. An install not yet taken
  // is cancelled with it.
  const tab = activeTab(state)
  const gone = !tab || tab.id !== tabId
  useEffect(() => {
    if (gone) leave(accepted.current ? 'install' : 'dismiss')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the tab's change only
  }, [gone])

  return (
    <DesktopPopover
      anchor={rects.anchor}
      bar={rects.bar}
      width={POPOVER_WIDTH.list}
      labelledBy={TITLE_ID}
      closing={closing || retired}
      collapse={rects.anchor !== null && folded}
      // Escape on a popover the user opened leaves the keyboard on the chip (`usePopover`'s
      // return); the offer's popover took none, so there is nothing to hand back.
      onClosed={(byKey) =>
        offered ? closeInstallOffer(tabId) : closeInstallSheet(tabId, { keepFocus: byKey })
      }
      onDismiss={dismiss}
      focus={offered ? 'none' : 'primary'}
      follow
      anchorElement={chip}
      data-install-popover=""
      data-offered={offered ? '' : undefined}
    >
      {() => (
        <>
          <TitleBlock id={TITLE_ID} title={`Install ${title}?`} />
          <div className="zen-install-app px-4">
            <AppIcon icon={icon} name={title} tint={tint} size={48} />
            <div className="min-w-0 flex-1">
              <div className="zen-install-name truncate">{title}</div>
              <div className="zen-install-detail truncate">{origin}</div>
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
