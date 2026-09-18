import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import {
  browserStore,
  captureActiveTab,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

const TITLE = 'Make Zenium Your Default Browser'
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
 * session is due one, as a bottom sheet on touch and a small centred dialog where a mouse drives
 * the chrome (DeX, a tablet with a trackpad) – one composition, a title block over a §9.11
 * footer, in the two chromes (v2 §9.23). "Set as default" hands
 * over to the system's role dialog; "Not now", the scrim, the back gesture and Escape all count
 * as one dismissal towards the campaign's limit. Hosts without the capability never get a
 * prompt to render.
 *
 * The page's view is the host's own and sits over the chrome on Android, so like the menu and
 * the protocol sheet the prompt goes up over a capture of the page (`overlayCoversContent` has
 * the host hide the view meanwhile). The capture waits for the page: once the active tab's load
 * has ended and a frame has painted (a fixed delay caught an unpainted page on the emulator),
 * or after `LOAD_WAIT_MS` for a page that will not finish. The page comes back once the prompt
 * is gone.
 */
export function DefaultBrowserLayer(): JSX.Element | null {
  const prompt = browserStore.use((s) => s.state?.defaultBrowser.prompt ?? null)
  const covering = uiStore.use((s) => s.defaultBrowserPrompt)
  const viewport = useViewport()
  useEffect(() => {
    if (prompt !== 'sheet') return
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
          if (!cancelled) uiStore.set({ defaultBrowserPrompt: true })
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
      uiStore.set({ defaultBrowserPrompt: false })
      invalidateSnapshot()
      returnFocusToPage()
    }
  }, [prompt])
  if (prompt !== 'sheet' || !covering) return null
  return viewport.coarse ? <PromoSheet /> : <PromoDialog />
}

/** "Set as default" from the promo: the campaign is over either way, the system takes it from here. */
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

/** Escape dismisses the prompt (hardware keyboards exist on tablets and DeX too). */
function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function PromoSheet(): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const { busy, request } = useRequest()
  // A "Set as default" slides the sheet away first; the role dialog then opens over a calm page.
  const choose = (then: () => void): void => sheet.current?.dismiss(then)

  useBackSurface({
    name: 'default-browser',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())

  // The sheet leaving for any reason other than "Set as default" is a "Not now".
  const chosen = useRef(false)
  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => {
        if (!chosen.current) dismiss()
      }}
      handleLabel="Resize prompt"
      className="zen-v2-sheet"
      header={
        // A prompt sheet has no 48 header (v2 §9.16, §9.23): after the grip strip the title
        // block, 16 px in from the sheet's edge (the chassis' 12 and 4 here) – it stays with
        // the grip, so it does not scroll and a drag starts on it as on a header.
        <div className="px-1 pt-4">
          <TitleBlock />
        </div>
      }
    >
      {/* 16 px from the description to the §9.11 footer: two peers, an 8 px gap, the primary trailing. */}
      <div className="px-1 pb-2 pt-4">
        <div className="flex gap-2">
          <button
            type="button"
            className="zen-v2-button flex-1"
            disabled={busy}
            onClick={() => choose(() => undefined)}
          >
            Not now
          </button>
          <button
            type="button"
            className="zen-v2-button flex-1"
            data-primary
            disabled={busy}
            onClick={() => {
              chosen.current = true
              choose(() => void request())
            }}
          >
            Set as default
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}

/**
 * The prompt's head, one composition for the sheet and the dialog (v2 §9.23): the glyph on the
 * title's start with no box behind it – the row glyph, 20 on phones and tablets and 16 on
 * desktop, at the row stroke, centred on the title line – the title 17/600 at line-height 22,
 * and the description 15 at 69% 4 px under it. The paragraph is the only content between the
 * title and the actions, which makes it the title block's description rather than body copy;
 * it reads at line-height 22 on a phone and 20 elsewhere.
 */
function TitleBlock({ id }: { id?: string }): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  return (
    <div className="flex flex-col gap-1">
      <h2 id={id} className="flex items-start gap-2 text-[17px] font-semibold leading-[22px]">
        <Globe className="zen-v2-title-glyph" aria-hidden />
        <span className="min-w-0 flex-1">{TITLE}</span>
      </h2>
      <p
        className={cn(
          'text-[15px] text-[var(--v2-text-deemphasized)]',
          phone ? 'leading-[22px]' : 'leading-[20px]'
        )}
      >
        {BODY}
      </p>
    </div>
  )
}

/**
 * The same prompt for a mouse: a dialog in the middle of the window over the scrim, the same
 * composition as the sheet in the dialog's chrome – padding 16, the title block, 16 px to the
 * footer; Escape, the scrim and the footer close it, so there is no X.
 */
function PromoDialog(): JSX.Element {
  const { busy, request } = useRequest()
  useBackSurface({ name: 'default-browser', onCommit: dismiss })
  useEscape(dismiss)
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="zen-v2-scrim absolute inset-0" onClick={dismiss} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="zen-default-browser-title"
        className="zen-v2-dialog zen-animate-pop relative flex w-[400px] max-w-[calc(100%-32px)] flex-col gap-4 p-4"
      >
        <TitleBlock id="zen-default-browser-title" />
        <div className="flex justify-end gap-2">
          <button type="button" className="zen-v2-button" disabled={busy} onClick={dismiss}>
            Not now
          </button>
          <button
            type="button"
            className="zen-v2-button"
            data-primary
            disabled={busy}
            onClick={() => void request()}
          >
            Set as default
          </button>
        </div>
      </div>
    </div>
  )
}
