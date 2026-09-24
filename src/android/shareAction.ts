import type { ShareAction } from '@shared/types'

/*
 * A tap on Zenium's own row in Android 14's share sheet (`share.action` host event, `Share.kt`'s
 * `onBrowserAction`; SH-02). The row reads Copy link, QR code, Long screenshot, Print – the
 * share panel's chips below 14, one order for one object on both paths (§9.38). QR code the host
 * answers itself; Copy link and Print are the core's (`Browser.onShareAction`); Long screenshot
 * is the chrome's editor over the page (SH-08), which the core has no action for, so the tap goes
 * to the chrome as the panel's request does (`share.panel`) – the same way the panel's chip reaches
 * the editor.
 */

/** The row's Long screenshot, the one kind the core does not take (`Share.KIND_LONG_SCREENSHOT`). */
export interface LongScreenshotShareAction {
  kind: 'longScreenshot'
  url: string
  tabId: string | null
}

export type HostShareAction = ShareAction | LongScreenshotShareAction

export interface ShareActionIo {
  /** The core's handling of the row's own kinds (Copy link, Print). */
  core(action: ShareAction): void
  /** The chrome's long-screenshot editor over the tab's page. */
  openLongScreenshot(tabId: string): void
}

/**
 * Route the row's tap: Long screenshot to the chrome's editor, the rest to the core. A Long
 * screenshot without a tab has no page to stitch (the row carries it only with one) and is dropped.
 */
export function routeShareAction(action: HostShareAction, io: ShareActionIo): void {
  if (action.kind === 'longScreenshot') {
    if (action.tabId) io.openLongScreenshot(action.tabId)
    return
  }
  io.core(action)
}
