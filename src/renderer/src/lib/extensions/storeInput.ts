import { isExtensionId, parseStorePageUrl, type StoreId } from '@core/extensions/store'
import type { ExtensionSource } from '@shared/types'

export interface StoreInstallRef {
  /** What `extension.installFromStore` takes: the id (or the URL the user pasted). */
  ref: string
  /** Known when the input was a store URL; an id alone lets main pick the store. */
  store?: StoreId
  id: string
}

/**
 * What the "Add from store" field accepts: a 32-letter extension id, or a Chrome Web Store or
 * Edge Add-ons listing URL (with or without the slug, with a scheme or without one).
 */
export function parseStoreInput(text: string): StoreInstallRef | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (isExtensionId(trimmed)) return { ref: trimmed, id: trimmed }
  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const page = parseStorePageUrl(candidate)
  if (!page) return null
  return { ref: page.id, store: page.store, id: page.id }
}

/** The second line of a row: where the extension came from. */
export function sourceLabel(source: ExtensionSource | undefined): string {
  switch (source) {
    case 'chrome-web-store':
      return 'Chrome Web Store'
    case 'edge-add-ons':
      return 'Edge Add-ons'
    case 'crx':
      return 'CRX file'
    case 'zip':
      return 'ZIP file'
    case 'unpacked':
    default:
      return 'Unpacked'
  }
}

/** The store listing for an installed extension, when its source has one. */
export function storePageUrl(source: ExtensionSource | undefined, id: string): string | null {
  if (!isExtensionId(id)) return null
  if (source === 'chrome-web-store') return `https://chromewebstore.google.com/detail/${id}`
  if (source === 'edge-add-ons') return `https://microsoftedge.microsoft.com/addons/detail/${id}`
  return null
}

/** `v4.9.132 · Chrome Web Store` */
export function versionAndSource(version: string, source: ExtensionSource | undefined): string {
  const v = version ? `v${version}` : ''
  const s = sourceLabel(source)
  return v ? `${v} · ${s}` : s
}
