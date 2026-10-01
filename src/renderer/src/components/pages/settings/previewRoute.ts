import {
  INTERNAL_PAGES,
  type InternalPageRegistry,
  parseInternalPageUrl
} from '@shared/internalPages'

/** What a chrome page's card draws of the page's address while the host has no picture of the page. */
export interface PreviewRoute {
  /** The page's title ("Settings", "History"). */
  title: string
  /**
   * The drill-in the tab is on – the bar's title: the section's label (`zen://settings/updates`
   * → "Updates") or the section's page's (`zen://settings/privacy/site-data` → "Site data") –
   * or null on the page's landing.
   */
  drillIn: string | null
  /** Whether the landing's rows are drawn: the landing of Settings (the page with sections). */
  landing: boolean
}

/**
 * The route a chrome page's address names, as its card draws it (`SettingsPreview`): the
 * landing, or the drill-in the tab is on. As the page itself reads the address
 * (`parseInternalPageUrl`): an unknown section is the landing, an unknown drill-in page is its
 * section. Null for an address that is not a registered page's.
 */
export function previewRouteOf(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): PreviewRoute | null {
  const ref = parseInternalPageUrl(url, pages)
  if (!ref) return null
  const page = pages[ref.id]
  const section = ref.section ? page.sections.find((s) => s.id === ref.section) : undefined
  const subpage =
    section && ref.subpage ? section.pages?.find((p) => p.id === ref.subpage) : undefined
  return {
    title: page.title,
    drillIn: subpage?.label ?? section?.label ?? null,
    landing: section === undefined && page.sections.length > 0
  }
}
