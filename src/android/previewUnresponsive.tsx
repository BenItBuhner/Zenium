/* eslint-disable react-refresh/only-export-components -- a preview-host module: the stand-in's sheet ships with the two calls that mount and unmount it, which the preview states use */
import type { JSX } from 'react'
import { useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Globe } from 'lucide-react'
import type { BottomSheetHandle } from '@renderer/components/sheet/BottomSheet'
import { PhoneSheet } from '@renderer/components/phone/PhoneSheet'

/**
 * The unresponsive-page prompt (ERR-16 / OS-36) as the preview host can show it. On a device the
 * prompt is native (`UnresponsivePrompt.kt`): the chrome that would draw it runs in the very
 * renderer that has stopped answering, so it cannot. The stills want the composition anyway –
 * the v2 prompt sheet (§9.23) with the site as its title block and Wait | Exit page as its §9.11
 * footer – so this draws it from the phone's own chassis, which the native sheet copies: the same
 * words (`strings.xml`), the same identity row (the favicon at 20, a globe for a page without
 * one), Exit page in the danger ink on the trailing side. Nothing hangs on this host: either
 * answer only takes the sheet down.
 */

/** `unresponsive_description` in `android/app/src/main/res/values/strings.xml`. */
export const UNRESPONSIVE_DESCRIPTION =
  'This page isn’t responding. You can wait for it to respond, or exit the page.'

let mounted: { root: Root; element: HTMLElement } | null = null

/** Raise the stand-in over the chrome for `site` (the page's host), with its favicon if any. */
export function showUnresponsivePrompt(site: string, favicon: string | null): void {
  hideUnresponsivePrompt()
  const element = document.createElement('div')
  element.dataset.preview = 'unresponsive'
  document.body.appendChild(element)
  const root = createRoot(element)
  mounted = { root, element }
  root.render(
    <UnresponsivePromptStandIn site={site} favicon={favicon} onClose={hideUnresponsivePrompt} />
  )
}

/** Take the stand-in down at once (the next state starts without it). */
export function hideUnresponsivePrompt(): void {
  const current = mounted
  if (!current) return
  mounted = null
  current.root.unmount()
  current.element.remove()
}

function UnresponsivePromptStandIn({
  site,
  favicon,
  onClose
}: {
  site: string
  favicon: string | null
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  return (
    <PhoneSheet
      name="unresponsive-page"
      title={{
        pose: 'block',
        text: site,
        icon: favicon ? (
          <img src={favicon} alt="" className="h-5 w-5 shrink-0 rounded-sm" />
        ) : (
          <Globe className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
        ),
        description: UNRESPONSIVE_DESCRIPTION
      }}
      focus="first"
      onClose={onClose}
      // One detent: a drag on the grip only sends the prompt away, which is Wait.
      handleLabel="Dismiss"
      sheetRef={sheet}
    >
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Wait
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-danger
          onClick={() => sheet.current?.dismiss()}
        >
          Exit page
        </button>
      </div>
    </PhoneSheet>
  )
}
