import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { appIconVariant } from '@shared/appIcon'
import type { DefaultBrowserRequestSource } from '@shared/types'
import { usePopover } from '@renderer/hooks/usePopover'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import {
  DEFAULT_BROWSER_PROMPT_TITLE,
  describeDefaultBrowserRequest,
  dismissDefaultBrowserBanner,
  requestDefaultBrowser
} from '@renderer/lib/defaultBrowser'
import { useViewport } from '@renderer/lib/formFactor'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import {
  browserStore,
  captureActiveTab,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore
} from '@renderer/lib/ui'
import { V2Button, V2TitleBlock } from '../extensions/v2'
import { AppIconImage } from '../pages/settings/blocks'
import { PhoneSheet } from '../phone/PhoneSheet'
import type { BottomSheetHandle } from '../sheet/BottomSheet'

/** Sentence case, as every sheet and prompt title (v2 §9.1). */
const TITLE = DEFAULT_BROWSER_PROMPT_TITLE
const BODY =
  'Links from other apps open in Zenium, in your Spaces, with your Boosts and settings. Android asks you to confirm.'
/** The prompt waits for the page under it to load before going up over its capture, at most this long. */
const LOAD_WAIT_MS = 5000
/**
 * The prompt is due the moment a session opens, when the restored page has not always started
 * loading yet; its load has this long to begin before a quiet tab counts as painted (the app
 * came back to the foreground onto a page that has been up for a while).
 */
const START_GRACE_MS = 400

/**
 * The browser-role promo (DEF-01): shown when the core's `DefaultBrowserService` decides a
 * session is due one, as a prompt sheet on touch and a prompt dialog where a mouse drives the
 * chrome (DeX, a tablet with a trackpad) – the one §9.23 composition in the two chromes: the
 * chassis' title block (the bare 20 px glyph on the title's start, 16 on desktop, the paragraph
 * as its description) over a §9.11 footer, both in the frame's dialog host (lib/portals.tsx).
 * "Set as default" hands over to the system's role dialog and the button is busy (§9.30) until
 * that dialog has come back; "Not now", the scrim, the back gesture and Escape all count as one
 * dismissal towards the campaign's limit. Hosts without the capability never get a prompt to
 * render.
 *
 * The page's view is the host's own and sits over the chrome on Android, so like the menu and
 * the protocol sheet the prompt goes up over a capture of the page (`overlayCoversContent` has
 * the host hide the view meanwhile). The capture waits for the page: once the active tab's load
 * has ended and a frame has painted (a fixed delay caught an unpainted page on the emulator),
 * or after `LOAD_WAIT_MS` for a page that will not finish. The page comes back once the prompt
 * is gone.
 *
 * The prompt outlives the core's `prompt` through a request: the core ends the campaign the
 * moment it hands over to the host (its rules do not change), while the sheet stays up with its
 * button busy until the host's promise settles, and leaves then; the core taking the prompt
 * down for any other reason slides the sheet away.
 *
 * The desktop has no campaign: its strip under the toolbar asks (`DefaultBrowserBanner`), and
 * its "Make default" raises the same composition as a dialog that says what the OS will do
 * before the hand-off (`AskDialog`, `ui.defaultBrowserAsk`).
 */
export function DefaultBrowserLayer(): JSX.Element | null {
  const ask = uiStore.use((s) => s.defaultBrowserAsk)
  return (
    <>
      <CampaignLayer />
      {ask && (
        <FrameDialogPortal>
          <AskDialog source={ask} />
        </FrameDialogPortal>
      )}
    </>
  )
}

/** The core's campaign (`defaultBrowser.prompt === 'sheet'`): the sheet on touch, the dialog on a mouse. */
function CampaignLayer(): JSX.Element | null {
  const due = browserStore.use((s) => s.state?.defaultBrowser.prompt === 'sheet')
  const viewport = useViewport()
  // The prompt is on screen: from the capture's end until it has left.
  const [up, setUp] = useState(false)
  useEffect(() => {
    if (!due) return
    let cancelled = false
    let shown = false
    let frame: number | null = null
    const tab = (): { id: string; loading: boolean } | null => {
      const state = browserStore.get().state
      return state ? activeTab(state) : null
    }
    // The paint follows the state by a frame; capture after it, then go up.
    const show = (): void => {
      if (shown) return
      shown = true
      frame = requestAnimationFrame(() => {
        void captureActiveTab(tab()?.id ?? null).then(() => {
          if (cancelled) return
          uiStore.set({ defaultBrowserPrompt: true })
          setUp(true)
        })
      })
    }
    let started = tab()?.loading === true
    const unsubscribe = browserStore.subscribe(() => {
      const current = tab()
      if (!current) show()
      else if (current.loading) started = true
      else if (started) show()
    })
    // A page whose load never began within the grace has long been up: capture it as it is.
    const grace = setTimeout(() => {
      if (!started) show()
    }, START_GRACE_MS)
    const settle = setTimeout(show, LOAD_WAIT_MS)
    if (!tab()) show()
    return () => {
      cancelled = true
      unsubscribe()
      clearTimeout(grace)
      clearTimeout(settle)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [due])
  // The prompt has left the screen: the page comes back.
  const gone = (): void => {
    setUp(false)
    uiStore.set({ defaultBrowserPrompt: false })
    invalidateSnapshot()
    returnFocusToPage()
  }
  if (!up) return null
  return viewport.coarse ? (
    <PromoSheet due={due} onGone={gone} />
  ) : (
    <PromoDialog due={due} onGone={gone} />
  )
}

interface PromoProps {
  /** The core still says the sheet is due; false once it has taken the prompt down. */
  due: boolean
  /** The prompt has left the screen. */
  onGone: () => void
}

/**
 * "Set as default" from the promo: the campaign is over either way, the system takes it from
 * here. `busy` holds while the host's role request is out – on Android until the role dialog has
 * come back – for §9.30's working button.
 */
function useRequest(): { busy: boolean; request: () => Promise<void> } {
  const [busy, setBusy] = useState(false)
  return {
    busy,
    request: async () => {
      if (busy) return
      setBusy(true)
      try {
        await cmd('defaultBrowser.request', { source: 'sheet' })
      } catch {
        // The host could not open the role dialog; the Settings row offers it again.
      } finally {
        setBusy(false)
      }
    }
  }
}

function dismiss(): void {
  run('defaultBrowser.dismiss', { prompt: 'sheet' })
}

/**
 * The phone's prompt sheet on the chassis (`PhoneSheet`: the frame's dialog host, the grip
 * strip, the §9.23 title block, the sheet's own scrim, back gesture, Escape and focus), with
 * the §9.11 footer straight under the title block – its 16 below serves as the 16 to the
 * buttons (§9.20), so the footer adds none of its own.
 */
function PromoSheet({ due, onGone }: PromoProps): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const { busy, request } = useRequest()
  // "Set as default" taken: the sheet leaving afterwards is not a "Not now".
  const chosen = useRef(false)
  // The role request is out: the core has cleared the prompt, the sheet holds until it is back.
  const requesting = useRef(false)
  useEffect(() => {
    if (!due && !requesting.current) sheet.current?.dismiss()
  }, [due])
  const setDefault = async (): Promise<void> => {
    chosen.current = true
    requesting.current = true
    await request()
    requesting.current = false
    sheet.current?.dismiss()
  }
  return (
    <PhoneSheet
      name="default-browser"
      // A prompt: the title block (§9.23) – the paragraph is the title's description.
      title={{
        pose: 'block',
        text: TITLE,
        icon: <Globe className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: BODY
      }}
      focus="first"
      handleLabel="Resize prompt"
      sheetRef={sheet}
      onClose={() => {
        if (!chosen.current) dismiss()
        onGone()
      }}
    >
      <div className="zen-sheet-footer pt-0">
        <V2Button disabled={busy} onClick={() => sheet.current?.dismiss()}>
          Not now
        </V2Button>
        <V2Button variant="primary" busy={busy} onClick={() => void setDefault()}>
          Set as default
        </V2Button>
      </div>
    </PhoneSheet>
  )
}

/** The same prompt for a mouse, placed through the frame's dialog host from the layer. */
function PromoDialog(props: PromoProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedDialog {...props} />
    </FrameDialogPortal>
  )
}

/**
 * A `--v2-dialog` at the form width (§9.20) over the host's §9.5 scrim: the title block with the
 * 16 px glyph, then the buttons hugging and right-aligned (§9.11), 16 from the block and 16 to
 * the edge. Escape, the scrim and "Not now" dismiss it, so there is no X; focus starts on the
 * primary and Tab wraps (§9.22). Under reduced motion the pop keeps only its fade (§11.3, the
 * shared `zen-animate-pop`).
 */
function HostedDialog({ due, onGone }: PromoProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { busy, request } = useRequest()
  const chosen = useRef(false)
  const requesting = useRef(false)
  // The dialog leaves once, whichever of Escape, the scrim, back or a button says so first.
  const left = useRef(false)
  const leave = (): void => {
    if (left.current) return
    left.current = true
    if (!chosen.current) dismiss()
    onGone()
  }
  useEffect(() => {
    if (!due && !requesting.current) leave()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the core's change only
  }, [due])
  const setDefault = async (): Promise<void> => {
    chosen.current = true
    requesting.current = true
    await request()
    requesting.current = false
    leave()
  }
  useFrameDialog({ onScrimPress: leave })
  useBackSurface({ name: 'default-browser', onCommit: leave })
  usePopover(ref, {
    onClose: leave,
    initial: (root) => root.querySelector<HTMLElement>('[data-accept]'),
    returnTo: null
  })
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="zen-default-browser-title"
      className="zen-v2 zen-v2-dialog zen-animate-pop flex max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
    >
      <V2TitleBlock
        id="zen-default-browser-title"
        title={TITLE}
        description={BODY}
        glyph={<Globe aria-hidden />}
      />
      <div className="flex justify-end gap-2 px-4 pb-4">
        <V2Button disabled={busy} onClick={leave}>
          Not now
        </V2Button>
        <V2Button variant="primary" data-accept busy={busy} onClick={() => void setDefault()}>
          Set as default
        </V2Button>
      </div>
    </div>
  )
}

/** How long the desktop prompt waits for the page's picture before it shows over a blank one. */
const SNAPSHOT_WAIT_MS = 250

/**
 * The desktop's prompt, raised by "Make default" on the strip: the §9.23 composition on a
 * `--v2-dialog` at the form width (§9.20) over the frame's §9.5 scrim – the app icon at 48 at
 * the top of the block, the title, one sentence saying what this OS does once the user says yes
 * (`describeDefaultBrowserRequest`: Windows opens Default apps for the user to finish there,
 * macOS asks itself, Linux registers and asks nothing), then the §9.11 footer, Not now and the
 * primary. Focus lands on the primary; Escape, the scrim and Not now close it and focus goes
 * back to the strip's button (§9.22); "Make default" hands over to the OS (`requestDefaultBrowser`,
 * whose refusal is a toast) and takes the strip down for this release – the request may stay
 * out for as long as the user takes in the system's own UI, so the dialog does not wait for it.
 * Like every frame dialog it goes up over the page's picture (`captureActiveTab`, then
 * `defaultBrowserPrompt` has the host hide the view) and the chassis keeps its panel through
 * the pop exit (#188).
 */
function AskDialog({ source }: { source: DefaultBrowserRequestSource }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const state = browserStore.use((s) => s.state)
  const tabId = state ? (activeTab(state)?.id ?? null) : null
  // The dialog holds its first paint until the page's picture is in place, then takes focus.
  const [active, setActive] = useState(false)
  // "Make default" taken: the strip goes with the dialog, so focus goes to the page instead.
  const chosen = useRef(false)
  // What had focus when the dialog was asked for – the strip's button – or nothing of the chrome's.
  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
  )
  // Where `usePopover` gives the focus back as the dialog goes: the opener, or nowhere once the
  // choice is made (the strip is on its way out then, and the page takes the focus).
  const returnTo = useRef<HTMLElement | null>(opener)

  useEffect(() => {
    let gone = false
    void Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ]).then(() => {
      if (gone) return
      run('focus.chrome', undefined)
      uiStore.set({ defaultBrowserPrompt: true })
      setActive(true)
    })
    return () => {
      gone = true
      if (uiStore.get().defaultBrowserPrompt) uiStore.set({ defaultBrowserPrompt: false })
      invalidateSnapshot()
      // `usePopover` gives the focus back to the opener – once the chrome is back from the
      // host's hold, which stands through the panel's exit; when there is none to go back to
      // (the strip went with the choice, or the page had the focus), the page takes it.
      if (chosen.current || !opener?.isConnected) returnFocusToPage()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the tab it opened on
  }, [])

  const close = (): void => {
    if (uiStore.get().defaultBrowserAsk !== null) uiStore.set({ defaultBrowserAsk: null })
  }
  const accept = (): void => {
    if (chosen.current) return
    chosen.current = true
    returnTo.current = null
    void requestDefaultBrowser(source)
    if (source === 'banner' && state) dismissDefaultBrowserBanner(state)
    close()
  }
  useFrameDialog({ onScrimPress: close })
  usePopover(ref, {
    onClose: close,
    active,
    initial: (root) => root.querySelector<HTMLElement>('[data-accept]'),
    returnTo
  })
  const platform = state?.platform ?? 'linux'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="zen-default-browser-ask-title"
      aria-describedby="zen-default-browser-ask-description"
      data-default-browser-ask={source}
      className="zen-v2 zen-v2-dialog zen-animate-pop flex max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
    >
      <AppIconImage
        variant={appIconVariant(state?.settings.appIcon)}
        className="zen-default-browser-prompt-icon"
      />
      <V2TitleBlock
        id="zen-default-browser-ask-title"
        title={TITLE}
        description={describeDefaultBrowserRequest(platform)}
        descriptionId="zen-default-browser-ask-description"
      />
      <div className="flex justify-end gap-2 px-4 pb-4">
        <V2Button onClick={close}>Not now</V2Button>
        <V2Button variant="primary" data-accept onClick={accept}>
          Make default
        </V2Button>
      </div>
    </div>
  )
}
