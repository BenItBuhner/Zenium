import type { JSX } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { ChevronLeft, Search, X } from 'lucide-react'
import {
  INTERNAL_PAGES,
  availableSections,
  landingRuns,
  parseInternalPageUrl,
  type InternalPageDefinition,
  type InternalPageSection
} from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { BackDismissal, useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { openBarEditor, openOverlay } from '@renderer/lib/ui'
import { SettingsBody } from '../../overlays/SettingsPanel'
import { SECTION_GLYPH, SECTION_GLYPHS } from './glyphs'
import { searchRows, type SectionModel } from './model'
import { GroupList, RowView, type RowContext } from './rows'
import { buildSection, buildSections, type SectionContext } from './sections'
import { SheetStack } from './sheets'
import { useSheetStack } from './useSheetStack'

/**
 * The Settings page inside its tab (`zen://settings[/<section>]`, design language v2 §10).
 *
 * Phone (§10.2): a landing – title block, "Find in Settings", the category list with Zen's two
 * hairlines – and, when the tab's URL names a section, a drill-in pane over it: 56 px bar header
 * with the back chevron, then the section's groups of rows. The landing stays mounted (inert)
 * beneath the drill-in, so the predictive back gesture slides the pane off it; the chevron, the
 * bottom bar's back and the system back are all `page.back`. Search is the landing's alone.
 *
 * Wider than {@link TWO_PANE_MIN_WIDTH} (tablets, a phone in landscape): the desktop panel's nav
 * and content inside the tab (§10.5); the nav switches sections without a history entry.
 */

/** Width from which the tab shows the two-pane layout (v2 §10.2, §10.5). */
export const TWO_PANE_MIN_WIDTH = 720

interface Props {
  state: UIState
  tab: Tab
}

export function SettingsPage({ state, tab }: Props): JSX.Element {
  const { width, formFactor } = useViewport()
  const page = INTERNAL_PAGES.settings
  const sections = availableSections(page, state.capabilities, formFactor)
  const ref = parseInternalPageUrl(tab.url)
  const current = sections.find((s) => s.id === ref?.section) ?? null
  if (width >= TWO_PANE_MIN_WIDTH) {
    return <TwoPane state={state} tab={tab} current={current} />
  }
  return <PhoneSettings state={state} tab={tab} page={page} sections={sections} current={current} />
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

function PhoneSettings({
  state,
  tab,
  page,
  sections,
  current
}: Props & {
  page: InternalPageDefinition
  sections: InternalPageSection[]
  current: InternalPageSection | null
}): JSX.Element {
  const sheets = useSheetStack()
  const [query, setQuery] = useState('')
  const ctx: SectionContext = {
    state,
    tab,
    set: (patch) => run('settings.update', patch),
    navigate: (section) => run('page.navigate', { tabId: tab.id, section }),
    openBarEditor: () => void openBarEditor(tab.id),
    boost: (tabId) => {
      run('tab.activate', { tabId })
      void openOverlay('boosts', tabId)
    }
  }
  const searching = current === null && query.trim() !== ''
  // The section shown, or – while the landing's search is on – every section for its results.
  const models: SectionModel[] = current
    ? [buildSection(current, ctx)]
    : searching
      ? buildSections(sections, ctx)
      : []
  const groups = models.flatMap((m) => m.groups)

  // A section change closes whatever sheet the previous one had open.
  const sectionId = current?.id ?? null
  const { closeAll } = sheets
  useEffect(() => closeAll(), [sectionId, closeAll])

  return (
    <div className="zen-settings-page" data-section={sectionId ?? 'landing'}>
      <Landing
        page={page}
        sections={sections}
        models={models}
        query={query}
        onQuery={setQuery}
        onOpen={(id) => run('page.navigate', { tabId: tab.id, section: id })}
        ctx={sheets.ctx}
        inert={current !== null}
      />
      {current && models[0] && (
        <DrillIn key={current.id} model={models[0]} tab={tab} ctx={sheets.ctx} />
      )}
      <SheetStack
        requests={sheets.requests}
        groups={groups}
        ctx={sheets.ctx}
        closeTop={sheets.closeTop}
      />
    </div>
  )
}

/**
 * The landing (§10.2): the page title, the search field, then the category rows in runs Zen's
 * two nav hairlines separate. Typing swaps the list for the matching rows of every category,
 * each under a "Category › Group" caption; Escape or the clear button brings the list back.
 */
function Landing({
  page,
  sections,
  models,
  query,
  onQuery,
  onOpen,
  ctx,
  inert
}: {
  page: InternalPageDefinition
  sections: readonly InternalPageSection[]
  models: readonly SectionModel[]
  query: string
  onQuery(query: string): void
  onOpen(sectionId: string): void
  ctx: RowContext
  inert: boolean
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const term = query.trim()
  const hits = term ? searchRows(models, query) : []
  return (
    <div className="zen-settings-landing" inert={inert || undefined}>
      <div className="zen-settings-scroll">
        <h1 className="zen-settings-page-title">{page.title}</h1>
        <div className="zen-settings-search">
          <Search className="zen-settings-search-glyph" aria-hidden="true" />
          <input
            ref={input}
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
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                e.stopPropagation()
                onQuery('')
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="zen-settings-search-clear zen-v2-icon-button"
              aria-label="Clear search"
              onClick={() => {
                onQuery('')
                input.current?.focus()
              }}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
        {term ? (
          hits.length === 0 ? (
            <p className="zen-settings-empty zen-settings-empty-page" role="status">
              No settings match “{term}”
            </p>
          ) : (
            <div className="zen-settings-results" aria-label="Matching settings">
              {hits.map((hit) => (
                <RowView
                  key={`${hit.section.id}:${hit.row.id}`}
                  row={hit.row}
                  ctx={ctx}
                  caption={hit.caption}
                />
              ))}
            </div>
          )
        ) : (
          <nav className="zen-settings-categories" aria-label="Settings categories">
            {landingRuns(page, sections).map((sectionsInRun, index) => (
              <Fragment key={sectionsInRun[0]?.id ?? index}>
                {index > 0 && <hr className="zen-settings-hairline" />}
                {sectionsInRun.map((section) => (
                  <CategoryRow key={section.id} section={section} onOpen={onOpen} />
                ))}
              </Fragment>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

/** One category (§10.2): 44 tall, the 20 px glyph at 16, the Title Case label, nothing else. */
function CategoryRow({
  section,
  onOpen
}: {
  section: InternalPageSection
  onOpen(sectionId: string): void
}): JSX.Element {
  const Glyph = SECTION_GLYPHS[section.id] ?? SECTION_GLYPH
  return (
    <button
      type="button"
      className="zen-settings-category zen-v2-row"
      data-section={section.id}
      onClick={() => onOpen(section.id)}
    >
      <Glyph className="zen-settings-category-glyph" aria-hidden="true" />
      <span className="zen-settings-category-label">{section.label}</span>
    </button>
  )
}

/**
 * A section as the drill-in pane (§10.2): the 56 px bar header – 44 px back button, the
 * section's label at 17/600 – above the section's groups, with §9.7's hairline once the body
 * has scrolled under the bar. The pane slides in from the side it will leave by; the predictive
 * back gesture moves it with the finger and `page.back` runs once it is off.
 */
function DrillIn({
  model,
  tab,
  ctx
}: {
  model: SectionModel
  tab: Tab
  ctx: RowContext
}): JSX.Element {
  const pane = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const dismissal = useRef<BackDismissal | null>(null)
  // Reached by the toolbar's back (a section left by a later one): it comes in from the left.
  const [fromBack] = useState(() => tab.canGoForward)
  useEffect(() => {
    const created = new BackDismissal({
      travel: pane.current?.clientWidth || 400,
      render: (value) => {
        const el = pane.current
        if (el) el.style.transform = `translate3d(${(value * 100).toFixed(3)}%, 0, 0)`
      },
      dismissed: () => run('page.back', { tabId: tab.id })
    })
    dismissal.current = created
    return () => {
      created.dispose()
      dismissal.current = null
    }
  }, [tab.id])
  useBackSurface({
    name: `settings-section:${model.section.id}`,
    onStart: () => dismissal.current?.start(),
    onProgress: (progress) => dismissal.current?.setProgress(progress),
    onCommit: () => dismissal.current?.commit(),
    onCancel: () => dismissal.current?.cancel()
  })
  const back = (): void => {
    if (dismissal.current) dismissal.current.commit()
    else run('page.back', { tabId: tab.id })
  }
  return (
    <section
      ref={pane}
      className="zen-settings-drill-in"
      data-from={fromBack ? 'left' : 'right'}
      data-scrolled={scrolled || undefined}
      aria-label={model.section.label}
    >
      <header className="zen-settings-bar">
        <button
          type="button"
          className="zen-settings-back zen-v2-icon-button"
          aria-label="Back to Settings"
          onClick={back}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <h1 className="zen-settings-bar-title">{model.section.label}</h1>
      </header>
      <div
        className="zen-settings-scroll"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <GroupList groups={model.groups} ctx={ctx} className="zen-settings-body" />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Two panes (tablet, landscape)
// ---------------------------------------------------------------------------

/**
 * The desktop panel's nav and content inside the tab (§10.5): no landing – the first category
 * shows when the URL names none – and the nav rewrites the tab's URL without a history entry.
 */
function TwoPane({
  state,
  tab,
  current
}: Props & { current: InternalPageSection | null }): JSX.Element {
  return (
    <div className="zen-settings-page zen-settings-two-pane">
      <SettingsBody
        state={state}
        section={current?.id ?? null}
        onSection={(id) => run('page.navigate', { tabId: tab.id, section: id, replace: true })}
      />
    </div>
  )
}
