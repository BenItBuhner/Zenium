import type { JSX, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, Search, X } from 'lucide-react'
import {
  INTERNAL_PAGES,
  availableSections,
  landingRuns,
  parseInternalPageUrl,
  type InternalPageDefinition,
  type InternalPageQuery,
  type InternalPageSection,
  type InternalPageSubpage
} from '@shared/internalPages'
import type { FormFactor, Settings, Tab, UIState } from '@shared/types'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { run } from '@renderer/lib/api'
import { useAutofillSettings } from '@renderer/lib/autofillSettings'
import { BackDismissal, useBackSurface } from '@renderer/lib/back'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { useDownloadDirectory } from '@renderer/lib/downloadDirectory'
import { extensionRevealStore } from '@renderer/lib/extensions/manage'
import { useViewport } from '@renderer/lib/formFactor'
import { privateLockStore } from '@renderer/lib/privateLock'
import { useReadAloudVoices } from '@renderer/lib/readAloudVoices'
import { useRemoteTabs } from '@renderer/lib/remoteTabs'
import { useLocalFonts } from '@renderer/lib/localFonts'
import { useDictionaryWords } from '@renderer/lib/spellcheckWords'
import { syncSetupStore } from '@renderer/lib/syncSetup'
import { openBarEditor, openOverlay } from '@renderer/lib/ui'
import { TWO_PANE_MIN_WIDTH } from '../PageFrame'
import { AddLanguagePage } from './AddLanguagePage'
import { DesktopSettings } from './desktop'
import { DrillInBackContext } from './drillIn'
import { useFontsDraft } from './fontsDraft'
import { SECTION_GLYPH, SECTION_GLYPHS } from './glyphs'
import { findRow, searchRows, type SectionModel } from './model'
import { GroupList, RowView, type RowContext } from './rows'
import { buildSection, buildSections, type SectionContext } from './sections'
import { SheetStack } from './sheets'
import { SiteDataPage } from './SiteDataPage'
import { useSheetStack } from './useSheetStack'

/**
 * The Settings page inside its tab (`zen://settings[/<section>[/<page>]]`, design language v2
 * §10).
 *
 * Phone (§10.2): a landing – title block, "Find in Settings", the category list with Zen's two
 * hairlines – and, when the tab's URL names a section, a drill-in pane over it: 56 px bar header
 * with the back chevron, then the section's groups of rows. The landing stays mounted (inert)
 * beneath the drill-in, so the predictive back gesture slides the pane off it; the chevron, the
 * bottom bar's back and the system back are all `tab.back`. A section's own drill-in page
 * (`InternalPageSection.pages`: Privacy's site-data viewer, Chrome's All sites; Languages' Add
 * language, the find-and-pick page) is a second pane the same way, over the section it belongs
 * to, reached from the row that names it (`ActionRow.page`, its parameters in the address as
 * `ActionRow.pageQuery`) and standing in the tab's history above the section. Search is the
 * landing's alone, and it never focuses on its own: on tap, or when the tab claims Ctrl+F /
 * "Find in Page" (`useChromeShortcut('find.open')`) as "Find in Settings".
 *
 * From {@link TWO_PANE_MIN_WIDTH} of the page's own width (a desktop window, a tablet, a phone
 * in landscape): the two-pane layout (`desktop.tsx`, §10.5) – the nav column and the content
 * column, the nav switching sections without a history entry. The page measures itself rather
 * than the window, so a split or a narrow window falls back to the landing and drill-ins.
 *
 * The page's parameters (`InternalPageQuery`): Privacy's `site` – `zen://settings/privacy?
 * site=<origin>` is the section asked for a site, the site-information sheet's "Requests
 * blocked" row, and opens with the site's own group ({@link SITE_ROW}, "Block on <host>") on
 * screen, where Chrome's order has it one screen down; Chrome's `siteDetails?site=`, less the
 * page of its own – and `row`, a section asked for one of its rows (`zen://settings/sync?row=
 * sync-scope:openTabs`, the History page's "Open sync settings" row landing on the Open tabs
 * switch), which opens with that row's group on screen the same way.
 */

/** Width from which the tab shows the two-pane layout (v2 §10.2, §10.5; the pages' shared one). */
export { TWO_PANE_MIN_WIDTH }

/** The row for the site Privacy was asked for (`tracking.tsx`): the switch its group is brought on screen for. */
const SITE_ROW = 'tracking-site-current'

/** A row id as `?row=` may carry it: the ids are words, colons and dashes (`sync-scope:openTabs`). */
const ROW_ID_RE = /^[\w:-]+$/

/**
 * The page's custom property for a landing's end pad (`main.css`: the column's body takes it as
 * `padding-bottom` while the page carries `data-landing`).
 */
const LANDING_PAD = '--zen-settings-landing-pad'

/**
 * How far the column must pad its end for `group` to scroll to its top. A group near a section's
 * end reaches only as far as the content under it allows – the desktop's #356 measured Sync's
 * Open tabs group mid-page at a 1000 px window, the column's scroll maxed at 169 – so the column
 * pads by what is missing, as Chrome's settings pages pad the page for a deep link. The top is
 * the column's scroll padding where it has some (the desktop's sticky find field, §10.5), so
 * the landed group's heading shows under the field rather than behind it. 0 when the group can
 * already reach the top, or when the group is in no column (a test without layout).
 */
function landingPad(group: HTMLElement): number {
  const column = group.closest<HTMLElement>('.zen-settings-scroll, .zen-settings-content')
  if (!column) return 0
  const top =
    group.getBoundingClientRect().top - column.getBoundingClientRect().top + column.scrollTop
  const inset = parseFloat(getComputedStyle(column).scrollPaddingTop) || 0
  return Math.max(0, Math.ceil(top - inset + column.clientHeight - column.scrollHeight))
}

/** What a section's drill-in page is handed: the section's context, the address's parameters, the tab. */
export interface SubpageProps {
  ctx: SectionContext
  query: InternalPageQuery
  tab: Tab
}

/**
 * What draws each section's drill-in page (`InternalPageSection.pages`, §10.2), by
 * `<section>/<page>`: the phone's second pane over the section. A page the registry names and
 * this does not draw would be an address with nothing behind it, so the two are kept together.
 */
const SUBPAGES: Record<string, (props: SubpageProps) => JSX.Element> = {
  'privacy/site-data': SiteDataPage,
  'languages/add': AddLanguagePage
}

interface Props {
  state: UIState
  tab: Tab
}

export function SettingsPage({ state, tab }: Props): JSX.Element {
  const { width: windowWidth, formFactor, hover } = useViewport()
  const root = useRef<HTMLDivElement>(null)
  // The window's width stands in until the page has measured its own (0 before the first
  // layout), so the first paint is already the right layout for a window that is not split.
  const measured = useElementWidth(root)
  const width = measured || windowWidth
  const page = INTERNAL_PAGES.settings
  const sections = availableSections(page, state.capabilities, formFactor, state.platform)
  const ref = parseInternalPageUrl(tab.url)
  const current = sections.find((s) => s.id === ref?.section) ?? null
  // The section's drill-in page the address names, on the phone layout; the two-pane layout
  // shows the section for it and opens the page's content as a dialog from its row (§10.5).
  const subpage = current?.pages?.find((p) => p.id === ref?.subpage) ?? null
  const twoPane = width >= TWO_PANE_MIN_WIDTH
  // Privacy asked for a site, or a section for one of its rows: the row's group is scrolled on
  // screen before the paint, once per address (and again should the layout change under it) – a
  // later visit to the section from the landing or the nav has no `site` or `row` and opens at
  // the top. The site's row is the opener's site's (`trackingGroups`); a restored tab without its
  // opener has none, and the page opens at the top as it would, as it does for a row the section
  // does not have. The column pads its end while the landing is asked (`landingPad`), so a
  // group near the section's end reaches the top too; an ordinary section keeps its end.
  const site = current?.id === 'privacy' ? (ref?.query?.site ?? null) : null
  const asked = ref?.query?.row
  const row = site ? SITE_ROW : asked && ROW_ID_RE.test(asked) ? asked : null
  useLayoutEffect(() => {
    const page = root.current
    if (!page) return
    // The pad is measured with none on, so a layout change under the landing re-measures it.
    page.style.removeProperty(LANDING_PAD)
    const group = row
      ? page.querySelector(`[data-row="${row}"]`)?.closest<HTMLElement>('[data-group]')
      : null
    if (!group) return
    const pad = landingPad(group)
    if (pad > 0) page.style.setProperty(LANDING_PAD, `${pad}px`)
    group.scrollIntoView({ block: 'start' })
  }, [row, tab.url, twoPane])
  return (
    <div
      ref={root}
      className="zen-settings-page"
      data-layout={twoPane ? 'two-pane' : 'phone'}
      data-landing={row ? '' : undefined}
    >
      {twoPane ? (
        <DesktopSettings
          state={state}
          tab={tab}
          page={page}
          sections={sections}
          current={current}
          pointer={hover}
          formFactor={formFactor}
        />
      ) : (
        <PhoneSettings
          state={state}
          tab={tab}
          page={page}
          sections={sections}
          current={current}
          subpage={subpage}
          params={ref?.query ?? NO_QUERY}
          pointer={hover}
          formFactor={formFactor}
        />
      )}
    </div>
  )
}

/** An address without parameters, the one object so a page's props do not change render to render. */
const NO_QUERY: InternalPageQuery = {}

/** A settings patch to the core (`SectionContext.set`); one function, so the fonts draft's hook keeps it. */
const settingsUpdate = (patch: Partial<Settings>): void => run('settings.update', patch)

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

function PhoneSettings({
  state,
  tab,
  page,
  sections,
  current,
  subpage,
  params,
  pointer,
  formFactor
}: Props & {
  page: InternalPageDefinition
  sections: InternalPageSection[]
  current: InternalPageSection | null
  /** The section's drill-in page the address names, over the section (§10.2). */
  subpage: InternalPageSubpage | null
  /** The address's parameters, for the drill-in page (Add language's `?list=`). */
  params: InternalPageQuery
  /** The host's primary pointer hovers (a mouse): rows may describe mouse gestures. */
  pointer: boolean
  formFactor: FormFactor
}): JSX.Element {
  const sheets = useSheetStack()
  const [query, setQuery] = useState('')
  // Ctrl+F / "Find in Page" on the Settings tab is "Find in Settings" (Firefox, Chrome): the
  // landing's field takes the focus – from inside a section the landing comes up first, as a
  // history entry, so back returns to the section. Counted so each request focuses once.
  const [findRequest, setFindRequest] = useState(0)
  useChromeShortcut('find.open', (find) => {
    if (find.tabId !== tab.id) return false
    if (current) run('page.navigate', { tabId: tab.id, section: null })
    setFindRequest((n) => n + 1)
    return true
  })
  // The vault's lists are fetched while Settings › Autofill is the section shown; the landing's
  // search builds the section with none (its switches and choices match, its entries do not).
  const autofill = useAutofillSettings(state, current?.id === 'autofill')
  // Whether the device has a screen lock, for Privacy and Security's private-tab lock switch.
  const screenLock = privateLockStore.use((s) => s.screenLock)
  // The speech engine's voices are asked for while Accessibility is the section shown (the
  // landing's search builds its voice rows from the list already kept, or shows none yet).
  const readAloudVoices = useReadAloudVoices(
    state.capabilities.readAloud && current?.id === 'accessibility'
  )
  // The custom dictionary's words likewise (a desktop host's narrow window; no phone host has one).
  const dictionary = useDictionaryWords(
    current?.id === 'languages' && state.spellcheck.available && formFactor !== 'phone'
  )
  // Settings › Sync's setup rows keep the folder chosen before sync is on outside the browser
  // state (`syncSetupStore`); the page is rebuilt when it changes so the folder row shows it.
  syncSetupStore.use((s) => s.folder)
  // The folder new downloads go to, while Downloads is the section shown (its Location row).
  const downloadDirectory = useDownloadDirectory(
    current?.id === 'downloads',
    state.settings.downloads?.directory ?? null
  )
  // The computer's font families while Look and Feel is the section shown, on a host whose
  // engine takes the family rows (Customise fonts' pickers; a phone host lists the generic names).
  const localFonts = useLocalFonts(current?.id === 'look' && state.capabilities.genericFontFamilies)
  // Likewise the other devices' open tabs, asked of the core once per `remoteTabsVersion`.
  useRemoteTabs(state.sync)
  // Customise fonts' draft: the ± rows' steps coalesced into one commit per quiet sequence,
  // flushed when the section is left (the drill-in's leave) or the page goes.
  const fontsDraft = useFontsDraft(state.settings.fonts, settingsUpdate, current?.id ?? null)
  const ctx: SectionContext = {
    state,
    tab,
    pointer,
    formFactor,
    set: settingsUpdate,
    navigate: (section) => run('page.navigate', { tabId: tab.id, section }),
    openBarEditor: () => void openBarEditor(tab.id),
    boost: (tabId) => {
      run('tab.activate', { tabId })
      void openOverlay('boosts', tabId)
    },
    autofill,
    screenLock,
    readAloudVoices,
    dictionary,
    downloadDirectory,
    localFonts,
    fontsDraft
  }
  const searching = current === null && query.trim() !== ''
  // The section shown, or – while the landing's search is on – every section for its results.
  const models: SectionModel[] = current
    ? [buildSection(current, ctx)]
    : searching
      ? buildSections(sections, ctx)
      : []
  const groups = models.flatMap((m) => m.groups)

  // A section change – or a drill-in page coming over the section, or leaving it – closes
  // whatever sheet the previous one had open.
  const sectionId = current?.id ?? null
  const subpageId = subpage?.id ?? null
  const { closeAll } = sheets
  useEffect(() => closeAll(), [sectionId, subpageId, closeAll])
  // "Manage extension" from elsewhere (an extension page's site information, the Extensions
  // sheet's long-press menu): Settings › Extensions opens the extension's details sheet as the
  // section comes up, once its row is in the list.
  const reveal = extensionRevealStore.use((s) => s.id)
  const { ctx: sheetCtx } = sheets
  useEffect(() => {
    if (!reveal || sectionId !== 'extensions') return
    const rowId = `extension:${reveal}`
    if (!groups.some((g) => g.rows.some((r) => r.id === rowId))) return
    extensionRevealStore.set({ id: null })
    sheetCtx.open({ kind: 'item', rowId })
  }, [reveal, sectionId, groups, sheetCtx])
  // A row that names its section's drill-in page (§10.2) leaves for it: the section shown, or –
  // from the landing's search – the section whose row it is; the row's parameters ride in the
  // address (Add language's `?list=`).
  const rowCtx: RowContext = {
    ...sheetCtx,
    openPage: (rowId, subpageId, query) => {
      const section =
        current?.id ?? models.find((m) => findRow(m.groups, rowId) !== null)?.section.id
      if (section) run('page.navigate', { tabId: tab.id, section, subpage: subpageId, query })
    }
  }
  const Subpage = current && subpage ? SUBPAGES[`${current.id}/${subpage.id}`] : undefined

  return (
    <div
      className="zen-settings-phone"
      data-section={sectionId ?? 'landing'}
      data-page={subpageId ?? undefined}
    >
      <Landing
        page={page}
        sections={sections}
        models={models}
        query={query}
        onQuery={setQuery}
        onOpen={(id) => run('page.navigate', { tabId: tab.id, section: id })}
        ctx={rowCtx}
        inert={current !== null}
        findRequest={findRequest}
      />
      {current && models[0] && (
        <DrillIn
          key={current.id}
          name={`settings-section:${current.id}`}
          title={current.label}
          backLabel="Back to Settings"
          tab={tab}
          inert={Subpage !== undefined}
        >
          <GroupList groups={models[0].groups} ctx={rowCtx} className="zen-settings-body" />
        </DrillIn>
      )}
      {current && subpage && Subpage && (
        <DrillIn
          key={`${current.id}/${subpage.id}`}
          name={`settings-page:${current.id}/${subpage.id}`}
          title={subpage.label}
          backLabel={`Back to ${current.label}`}
          tab={tab}
        >
          <Subpage ctx={ctx} query={params} tab={tab} />
        </DrillIn>
      )}
      <SheetStack
        requests={sheets.requests}
        groups={groups}
        ctx={rowCtx}
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
  inert,
  findRequest
}: {
  page: InternalPageDefinition
  sections: readonly InternalPageSection[]
  models: readonly SectionModel[]
  query: string
  onQuery(query: string): void
  onOpen(sectionId: string): void
  ctx: RowContext
  inert: boolean
  /** Incremented for each "Find in Settings" request the field is to take the focus for. */
  findRequest: number
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const term = query.trim()
  const hits = term ? searchRows(models, query) : []
  // The field never focuses on its own (no autofocus on phone); a find request focuses it once
  // the landing is reachable – at once on the landing, after the drill-in is gone otherwise.
  const served = useRef(0)
  useEffect(() => {
    if (findRequest === served.current || inert) return
    served.current = findRequest
    input.current?.focus()
    input.current?.select()
  }, [findRequest, inert])
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
 * A drill-in pane (§10.2) – a section over the landing, or a section's own page over the
 * section: the 56 px bar header – 44 px back button, the pane's title at 17/600 – above its
 * body (the section's groups, the page's content), with §9.7's hairline once the body has
 * scrolled under the bar. The pane slides in from the side it will leave by; the predictive
 * back gesture moves it with the finger and `tab.back` runs once it is off – the pane mounted
 * last answers the gesture, so a page over its section leaves first. A pane with a pane over it
 * is `inert`, as the landing is under a section.
 */
function DrillIn({
  name,
  title,
  backLabel,
  tab,
  inert = false,
  children
}: {
  /** For the back registry's logs. */
  name: string
  title: string
  /** The back button's name: where it leads ("Back to Settings", "Back to Privacy and Security"). */
  backLabel: string
  tab: Tab
  inert?: boolean
  children: ReactNode
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
      dismissed: () => run('tab.back', { tabId: tab.id })
    })
    dismissal.current = created
    return () => {
      created.dispose()
      dismissal.current = null
    }
  }, [tab.id])
  // A pane under another leaves the gesture to the one on top (`useBackSurface`: the surface
  // registered last answers; an inert pane registers none).
  useBackSurface(
    inert
      ? null
      : {
          name,
          onStart: () => dismissal.current?.start(),
          onProgress: (progress) => dismissal.current?.setProgress(progress),
          onCommit: () => dismissal.current?.commit(),
          onCancel: () => dismissal.current?.cancel()
        }
  )
  const back = useCallback((): void => {
    if (dismissal.current) dismissal.current.commit()
    else run('tab.back', { tabId: tab.id })
  }, [tab.id])
  return (
    <section
      ref={pane}
      className="zen-settings-drill-in"
      data-from={fromBack ? 'left' : 'right'}
      data-scrolled={scrolled || undefined}
      aria-label={title}
      inert={inert || undefined}
    >
      <header className="zen-settings-bar">
        <button
          type="button"
          className="zen-settings-back zen-v2-icon-button"
          aria-label={backLabel}
          onClick={back}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <h1 className="zen-settings-bar-title">{title}</h1>
      </header>
      <div
        className="zen-settings-scroll"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <DrillInBackContext.Provider value={back}>{children}</DrillInBackContext.Provider>
      </div>
    </section>
  )
}
