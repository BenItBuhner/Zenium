import type { JSX, ReactNode, RefObject } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Search, Settings as SettingsGlyph, X } from 'lucide-react'
import {
  landingRuns,
  type InternalPageDefinition,
  type InternalPageSection
} from '@shared/internalPages'
import type { FormFactor, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { openBarEditor, openOverlay } from '@renderer/lib/ui'
import { DialogStack } from './dialogs'
import { SECTION_GLYPH, SECTION_GLYPHS } from './glyphs'
import { searchRows, type RowGroup, type SearchHit, type SectionModel } from './model'
import { GroupList, RowView, type RowContext } from './rows'
import { buildSection, buildSections, type SectionContext } from './sections'
import { SheetStack } from './sheets'
import { useSheetStack } from './useSheetStack'

/**
 * The Settings tab where two panes fit (design language v2 §10.5; Zen's `about:preferences`):
 * a 234 px nav column – the gear and "Settings" 22/600 at its top, then the categories as 34 px
 * items (glyph 16, Title Case), Zen's order with its two hairlines before Sync and before About,
 * the open one on the `--v2-nav-active` fill with a 3 px accent bar – beside the content
 * column: the "Find in Settings" field first, sticky, then the section's 22/600 title and its
 * groups of rows in the desktop vocabulary (`rows.tsx`: 32 px rows, menulists, checkboxes,
 * inline fields, buttons), the text column at most 664 wide inside 32 px side margins.
 *
 * There is no landing on the desktop: the tab's URL without a section shows the first category;
 * the nav switches categories through `page.navigate` with `replace: true`, so the URL follows
 * (`zenium://settings/<section>`) without a history entry and back leaves Settings, as Firefox's
 * `about:preferences#category` does. A link that asked for a section opened it with a history
 * entry of its own, which back and forward step through. The rows' dialogs (`dialogs.tsx`)
 * share the phone's request stack.
 *
 * Find in Settings (§10.5): Ctrl+F / "Find in Page" on the tab focuses the field
 * (`useChromeShortcut('find.open')` – the find bar has no page text to search). Typing filters
 * the open category's rows in place, its group headings kept, and lists every other category's
 * matching rows under an "Other categories" heading with a 13/69% "Category › Group" caption
 * above each (Firefox's search-in-preferences across panes). Escape or the clear button puts
 * the category back; choosing a category in the nav does the same.
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
  const sectionId = shown?.id ?? null
  const sheets = useSheetStack()
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

  // The search: a query while it is not empty. A section change (the nav, back, forward)
  // starts the new category without it.
  const [query, setQuery] = useState('')
  const [querySection, setQuerySection] = useState(sectionId)
  if (querySection !== sectionId) {
    setQuerySection(sectionId)
    setQuery('')
  }
  const term = query.trim()
  const searching = term !== ''
  const find = useRef<HTMLInputElement>(null)
  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    find.current?.focus()
    find.current?.select()
    return true
  })

  const model: SectionModel | null = shown ? buildSection(shown, ctx) : null
  // Every category, built, while a search is on: its results and the rows their dialogs resolve.
  const models: SectionModel[] = searching ? buildSections(sections, ctx) : model ? [model] : []
  const hits = searching ? searchRows(models, query) : []

  // A section change closes whatever dialog the previous one had open.
  const { closeAll } = sheets
  useEffect(() => closeAll(), [sectionId, closeAll])

  const open = (id: string): void => {
    setQuery('')
    run('page.navigate', { tabId: tab.id, section: id, replace: true })
  }

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
                  onOpen={open}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </nav>
      {shown && model && (
        // Keyed on the section: a new category starts at the top of a fresh column.
        <ContentColumn key={shown.id} section={shown} query={query} onQuery={setQuery} field={find}>
          {searching ? (
            <FindResults section={shown} term={term} hits={hits} ctx={sheets.ctx} />
          ) : (
            <GroupList
              groups={model.groups}
              ctx={sheets.ctx}
              variant="desktop"
              className="zen-settings-body"
            />
          )}
        </ContentColumn>
      )}
      {formFactor === 'phone' ? (
        // The two panes inside the phone shell (a phone in landscape): the frame's dialog host
        // is on the sheet chassis there, so a row's dialog is the phone's sheet (§9.23).
        <SheetStack
          requests={sheets.requests}
          groups={models.flatMap((m) => m.groups)}
          ctx={sheets.ctx}
          closeTop={sheets.closeTop}
        />
      ) : (
        <DialogStack
          requests={sheets.requests}
          groups={models.flatMap((m) => m.groups)}
          ctx={sheets.ctx}
          closeTop={sheets.closeTop}
        />
      )}
    </div>
  )
}

/**
 * The content column (§10.5): the "Find in Settings" field first, sticky at the column's top
 * with §9.7's hairline once the column has scrolled under it; then the pane – the section's
 * 22/600 title as its first element, and its body or the search's results.
 */
function ContentColumn({
  section,
  query,
  onQuery,
  field,
  children
}: {
  section: InternalPageSection
  query: string
  onQuery(query: string): void
  field: RefObject<HTMLInputElement | null>
  children: ReactNode
}): JSX.Element {
  const [scrolled, setScrolled] = useState(false)
  return (
    <div
      className="zen-settings-content"
      data-scrolled={scrolled || undefined}
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
    >
      <FindField query={query} onQuery={onQuery} field={field} />
      <section className="zen-settings-pane" aria-labelledby="zen-settings-section-title">
        <h2 id="zen-settings-section-title" className="zen-settings-section-title">
          {section.label}
        </h2>
        {children}
      </section>
    </div>
  )
}

/**
 * "Find in Settings" (§10.5, §9.12): the 32 px `--v2-field` with its 16 px glyph and, while
 * there is a query, the clear icon button. Escape clears the query, and with none to clear
 * leaves the field (the focus returns to the page), so a second Escape is the chrome's again.
 */
function FindField({
  query,
  onQuery,
  field
}: {
  query: string
  onQuery(query: string): void
  field: RefObject<HTMLInputElement | null>
}): JSX.Element {
  return (
    <div className="zen-settings-find">
      <div className="zen-settings-search">
        <Search className="zen-settings-search-glyph" aria-hidden="true" />
        <input
          ref={field}
          type="text"
          role="searchbox"
          className="zen-v2-field zen-settings-search-field"
          placeholder="Find in Settings"
          aria-label="Find in Settings"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            if (query) onQuery('')
            else e.currentTarget.blur()
          }}
        />
        {query && (
          <button
            type="button"
            className="zen-settings-search-clear zen-v2-icon-button"
            aria-label="Clear search"
            onClick={() => {
              onQuery('')
              field.current?.focus()
            }}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The search's results (§10.5): the open category's groups with only their matching rows, the
 * headings kept, then every other category's matches as one flat list under an "Other
 * categories" sub-heading, a "Category › Group" caption on each row (§10.2). Nothing matching
 * anywhere is §9.17's one sentence.
 */
function FindResults({
  section,
  term,
  hits,
  ctx
}: {
  section: InternalPageSection
  term: string
  hits: readonly SearchHit[]
  ctx: RowContext
}): JSX.Element {
  if (hits.length === 0) {
    return (
      <p className="zen-settings-empty zen-settings-empty-page" role="status">
        No settings match “{term}”
      </p>
    )
  }
  // The open category's matches keep their groups: a group is its matching rows, and one whose
  // rows all fall out is gone with its heading.
  const groups: RowGroup[] = []
  const elsewhere: SearchHit[] = []
  for (const hit of hits) {
    if (hit.section.id !== section.id) {
      elsewhere.push(hit)
      continue
    }
    const group = groups.find((g) => g.id === hit.group.id)
    if (group) group.rows.push(hit.row)
    else groups.push({ ...hit.group, rows: [hit.row] })
  }
  return (
    <GroupList
      groups={groups}
      ctx={ctx}
      variant="desktop"
      className="zen-settings-body zen-settings-find-results"
    >
      {elsewhere.length > 0 && (
        <section
          className="zen-settings-group zen-settings-other-categories"
          aria-label="Other categories"
        >
          <h3 className="zen-settings-heading">Other categories</h3>
          <div className="zen-settings-results">
            {elsewhere.map((hit) => (
              <RowView
                key={`${hit.section.id}:${hit.row.id}`}
                row={hit.row}
                ctx={ctx}
                caption={hit.caption}
                variant="desktop"
              />
            ))}
          </div>
        </section>
      )}
    </GroupList>
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
