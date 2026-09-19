import { useMemo } from 'react'
import type { ExtensionInfo } from '@shared/types'
import { displayHost, extensionPageOf, type ExtensionPage } from '@shared/url'
import { browserStore } from '@renderer/lib/ui'

/**
 * What the chrome shows for a tab on an extension's page (v2 §10.1 applied to
 * `chrome-extension://` pages): the extension stands where a site would – its icon in the
 * favicon slot, its name where the phone pill shows a host and where a page without a title
 * would show one – and its `chrome-extension://<id>/<path>` address wherever a URL is shown,
 * whichever form the tab carries (`extensionPageOf`).
 */
export interface ExtensionPageChrome extends ExtensionPage {
  /** The extension's name; its id while the chrome knows no extension by it (removed, not yet listed). */
  name: string
  /** The manifest icon, or null for the puzzle glyph (`ExtensionIcon`). */
  icon: string | null
  extension: ExtensionInfo | null
}

/** The extension page `url` shows, presented through the installed `extensions`; null for any other address. */
export function extensionPageChrome(
  url: string,
  extensions: readonly ExtensionInfo[]
): ExtensionPageChrome | null {
  const page = extensionPageOf(url)
  if (!page) return null
  const extension = extensions.find((e) => e.id === page.id) ?? null
  return {
    ...page,
    name: extension?.name.trim() || page.id,
    icon: extension?.icon ?? null,
    extension
  }
}

const NONE: readonly ExtensionInfo[] = []

/** The window's extension list, re-read as it changes (empty until the state arrives). */
export function useExtensionList(): readonly ExtensionInfo[] {
  return browserStore.use((s) => s.state?.extensions ?? NONE)
}

/** `extensionPageChrome` against the window's extension list, re-read as it changes. */
export function useExtensionPage(url: string): ExtensionPageChrome | null {
  const extensions = useExtensionList()
  return useMemo(() => extensionPageChrome(url, extensions), [url, extensions])
}

/**
 * `displayHost` for a list row's second line, with an extension's name standing where the
 * host would for a page of its (the id while the extension is unknown), as the phone pill does.
 */
export function presentedHost(url: string, extensions: readonly ExtensionInfo[]): string {
  return extensionPageChrome(url, extensions)?.name ?? displayHost(url)
}
