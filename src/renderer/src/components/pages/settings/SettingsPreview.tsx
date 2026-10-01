import type { JSX } from 'react'
import { ChevronLeft, Search } from 'lucide-react'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import { useViewport } from '@renderer/lib/formFactor'
import { browserStore } from '@renderer/lib/ui'
import { SECTION_GLYPH, SECTION_GLYPHS } from './glyphs'
import { previewRouteOf } from './previewRoute'

/**
 * What a chrome page's card draws while the host has no picture of the page (v2 §10.1: "the page
 * as the thumbnail") – a tab restored before its first capture, a host that takes none: the page
 * as its address names it, scaled to the card by container units (a full page is 412 wide).
 * The landing of Settings is drawn as the landing – title, search field, the first categories;
 * a tab on a section or on a section's drill-in page (`zen://settings/updates`,
 * `zen://settings/privacy/site-data`) is drawn as that drill-in – its bar, the back chevron and
 * the section's or the page's title, over its empty pane – never as the landing it is not on
 * (`previewRouteOf`); another chrome page shows its title. Decoration only: nothing here is a
 * target or a live row. Where the host pictures its chrome (Android, `chrome.snapshot`) the
 * card shows that picture instead (`TabPreview`), and this stands in only until it arrives.
 */
export function SettingsPreview({ url }: { url: string }): JSX.Element {
  const caps = browserStore.use((s) => s.state?.capabilities ?? null)
  const { formFactor } = useViewport()
  const route = previewRouteOf(url)
  const page = INTERNAL_PAGES.settings
  const sections = caps ? availableSections(page, caps, formFactor) : page.sections
  if (route && route.drillIn !== null) {
    return (
      <div className="zen-settings-preview" aria-hidden="true" data-route="drill-in">
        <div className="zen-settings-preview-bar">
          <ChevronLeft />
          <span className="zen-settings-preview-bar-title">{route.drillIn}</span>
        </div>
      </div>
    )
  }
  if (route && !route.landing) {
    return (
      <div className="zen-settings-preview" aria-hidden="true" data-route="page">
        <div className="zen-settings-preview-page">
          <span className="zen-settings-preview-title">{route.title}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="zen-settings-preview" aria-hidden="true" data-route="landing">
      <div className="zen-settings-preview-page">
        <span className="zen-settings-preview-title">{page.title}</span>
        <span className="zen-settings-preview-field">
          <Search />
          Find in Settings
        </span>
        {sections.slice(0, 12).map((section) => {
          const Glyph = SECTION_GLYPHS[section.id] ?? SECTION_GLYPH
          return (
            <span key={section.id} className="zen-settings-preview-row">
              <Glyph />
              {section.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}
