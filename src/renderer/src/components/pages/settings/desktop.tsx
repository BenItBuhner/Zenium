import type { JSX, ReactNode } from 'react'
import { Fragment, useEffect } from 'react'
import { Settings as SettingsGlyph } from 'lucide-react'
import {
  landingRuns,
  type InternalPageDefinition,
  type InternalPageSection
} from '@shared/internalPages'
import type { FormFactor, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { openBarEditor, openOverlay } from '@renderer/lib/ui'
import { SettingsBody } from '../../overlays/SettingsPanel'
import { DialogStack } from './dialogs'
import { SECTION_GLYPH, SECTION_GLYPHS } from './glyphs'
import type { SectionModel } from './model'
import { GroupList } from './rows'
import { buildSection, hasRows, type SectionContext } from './sections'
import { SheetStack } from './sheets'
import { useSheetStack } from './useSheetStack'

/**
 * The Settings tab where two panes fit (design language v2 §10.5; Zen's `about:preferences`):
 * a 234 px nav column – the gear and "Settings" 22/600 at its top, then the categories as 34 px
 * items (glyph 16, Title Case), Zen's order with its two hairlines before Sync and before About,
 * the open one on the `--v2-nav-active` fill with a 3 px accent bar – beside the content
 * column: the section's 22/600 title first, then its groups of rows in the desktop vocabulary
 * (`rows.tsx`: 32 px rows, menulists, checkboxes, inline fields, buttons), the text column at
 * most 664 wide inside 32 px side margins.
 *
 * There is no landing on the desktop: the tab's URL without a section shows the first category;
 * the nav switches categories through `page.navigate` with `replace: true`, so the URL follows
 * (`zenium://settings/<section>`) without a history entry and back leaves Settings, as Firefox's
 * `about:preferences#category` does. A link that asked for a section opened it with a history
 * entry of its own, which back and forward step through. The rows' dialogs (`dialogs.tsx`)
 * share the phone's request stack.
 */
export function DesktopSettings({
  state,
  tab,
  page,
  sections,
  current,
  pointer,
  formFactor
}: {
  state: UIState
  tab: Tab
  page: InternalPageDefinition
  sections: readonly InternalPageSection[]
  /** The section the tab's URL names; none shows the first. */
  current: InternalPageSection | null
  /** The host's primary pointer hovers (a mouse): rows may describe mouse gestures. */
  pointer: boolean
  /** The chrome's layout (a phone in landscape reaches the two panes inside the phone shell). */
  formFactor: FormFactor
}): JSX.Element {
  const shown = current ?? sections[0] ?? null
  const sheets = useSheetStack()
  // Ctrl+F / "Find in Page" on the Settings tab is the page's: the find bar has no page text
  // to search. Until the content column carries its "Find in Settings" field the key is taken
  // and idle rather than opening a bar that finds nothing.
  useChromeShortcut('find.open', (find) => find.tabId === tab.id)
  const ctx: SectionContext = {
    state,
    tab,
    pointer,
    formFactor,
    set: (patch) => run('settings.update', patch),
    navigate: (section) => run('page.navigate', { tabId: tab.id, section, replace: true }),
    openBarEditor: () => void openBarEditor(tab.id),
    boost: (tabId) => {
      run('tab.activate', { tabId })
      void openOverlay('boosts', tabId)
    }
  }
  const model: SectionModel | null = shown ? buildSection(shown, ctx) : null

  // A section change closes whatever dialog the previous one had open.
  const sectionId = shown?.id ?? null
  const { closeAll } = sheets
  useEffect(() => closeAll(), [sectionId, closeAll])

  return (
    <div className="zen-settings-two-pane" data-testid="settings-page" data-section={sectionId}>
      <nav className="zen-settings-nav" aria-label="Settings categories">
        <div className="zen-settings-nav-title">
          <SettingsGlyph className="zen-settings-nav-title-glyph" aria-hidden="true" />
          <h1>{page.title}</h1>
        </div>
        <div className="zen-settings-nav-list">
          {landingRuns(page, sections).map((sectionsInRun, index) => (
            <Fragment key={sectionsInRun[0]?.id ?? index}>
              {index > 0 && <hr className="zen-settings-hairline" />}
              {sectionsInRun.map((section) => (
                <NavItem
                  key={section.id}
                  section={section}
                  active={section.id === sectionId}
                  onOpen={(id) =>
                    run('page.navigate', { tabId: tab.id, section: id, replace: true })
                  }
                />
              ))}
            </Fragment>
          ))}
        </div>
      </nav>
      {shown && model && (
        // Keyed on the section: a new category starts at the top of a fresh column.
        <ContentColumn key={shown.id} section={shown}>
          {hasRows(shown.id) ? (
            <GroupList
              groups={model.groups}
              ctx={sheets.ctx}
              variant="desktop"
              className="zen-settings-body"
            />
          ) : (
            // A category the phone has no rows for (Compact Mode, Resources, Sync, Keyboard
            // Shortcuts, Default Browser): the desktop's own content.
            <div className="zen-settings-body zen-settings-desktop-body">
              <SettingsBody state={state} section={shown.id} />
            </div>
          )}
        </ContentColumn>
      )}
      {formFactor === 'phone' ? (
        // The two panes inside the phone shell (a phone in landscape): the frame's dialog host
        // is on the sheet chassis there, so a row's dialog is the phone's sheet (§9.23).
        <SheetStack
          requests={sheets.requests}
          groups={model?.groups ?? []}
          ctx={sheets.ctx}
          closeTop={sheets.closeTop}
        />
      ) : (
        <DialogStack
          requests={sheets.requests}
          groups={model?.groups ?? []}
          ctx={sheets.ctx}
          closeTop={sheets.closeTop}
        />
      )}
    </div>
  )
}

/**
 * The content column (§10.5): the section's 22/600 title as the pane's first element, then its
 * body; the column scrolls on its own.
 */
function ContentColumn({
  section,
  children
}: {
  section: InternalPageSection
  children: ReactNode
}): JSX.Element {
  return (
    <div className="zen-settings-content">
      <section className="zen-settings-pane" aria-labelledby="zen-settings-section-title">
        <h2 id="zen-settings-section-title" className="zen-settings-section-title">
          {section.label}
        </h2>
        {children}
      </section>
    </div>
  )
}

/** One nav item (§10.5): 34 tall, the 16 px glyph, the Title Case label; the open one is marked. */
function NavItem({
  section,
  active,
  onOpen
}: {
  section: InternalPageSection
  active: boolean
  onOpen(sectionId: string): void
}): JSX.Element {
  const Glyph = SECTION_GLYPHS[section.id] ?? SECTION_GLYPH
  return (
    <button
      type="button"
      className="zen-settings-nav-item"
      data-section={section.id}
      aria-current={active ? 'page' : undefined}
      onClick={() => onOpen(section.id)}
    >
      <Glyph className="zen-settings-nav-item-glyph" aria-hidden="true" />
      <span className="zen-settings-nav-item-label">{section.label}</span>
    </button>
  )
}
