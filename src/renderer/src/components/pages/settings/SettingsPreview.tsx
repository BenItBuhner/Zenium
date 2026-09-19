import type { JSX } from 'react'
import { Search } from 'lucide-react'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import { useViewport } from '@renderer/lib/formFactor'
import { browserStore } from '@renderer/lib/ui'
import { SECTION_GLYPH, SECTION_GLYPHS } from './glyphs'

/**
 * The Settings tab's thumbnail (v2 §10.1: "the page as the thumbnail"): a page tab has no view
 * to capture, so the overview card, the swipe stage and the bar's carried card draw a still of
 * the landing – title, search field, the first categories – scaled to the card by container
 * units (a full page is 412 wide). Decoration only: nothing here is a target or a live row.
 */
export function SettingsPreview(): JSX.Element {
  const caps = browserStore.use((s) => s.state?.capabilities ?? null)
  const { formFactor } = useViewport()
  const page = INTERNAL_PAGES.settings
  const sections = caps ? availableSections(page, caps, formFactor) : page.sections
  return (
    <div className="zen-settings-preview" aria-hidden="true">
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
