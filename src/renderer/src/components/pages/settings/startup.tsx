import { MAX_STARTUP_PAGES, sanitizeStartupPages } from '@core/startup'
import type { StartupMode, UIState } from '@shared/types'
import { displayUrl } from '@shared/url'
import { extensionControlled } from './controlled'
import { choice, type RowGroup, type SettingsRow } from './model'
import { StartupPageForm } from './startupBlocks'
import type { SectionContext } from './sections'

/**
 * Settings › On startup (settings-47; Chrome's Settings › On startup): the choice – "Open the
 * New Tab page", "Continue where you left off", "Open a specific page or set of pages" – as a
 * §9.13 value row (the desktop's menulist, the phone's picker sheet, as the section's other
 * choices are), and under the third choice the pages list: one item row per page – a row with
 * several actions and nothing to set, so on a mouse it trails §10.5's 28 ⋯ ("Options for
 * <page>") whose menu is Edit… (a one-field form, the address) and Remove, the latter in the
 * plain ink and asking nothing (§10.4: a preference re-entered in one field is not the user's
 * data; Languages' Remove is the precedent) – then Add a new page (the same form) and Use
 * current pages (the open tabs' web addresses, in the sidebar's order, replacing the list –
 * Chrome's) – the list capped at `MAX_STARTUP_PAGES`, and an empty list saying so in one row
 * (§9.17's in-group form) since it starts on the New Tab page until a page is added.
 *
 * An enabled extension's `chrome_settings_overrides.startup_pages` holds the setting
 * (`state.extensionControls` keyed `startup.mode` and `startup.pages`, the host's word): the
 * mode row is drawn controlled showing the choice in effect, the extension's pages stand as
 * static rows under it – the same extension's run, so one "Controlled by <name>" indicator
 * closes it (§10.5's primitive) – and the editor's rows are left out, since nothing of the
 * user's is in effect; the user's own choice and list stay in the setting underneath and stand
 * again when the extension is disabled or uninstalled. The rows are a windowed host's (the
 * phone's boot knows two startups and keeps its switch, `tabsSection`).
 */

const KEYWORDS = ['startup', 'on startup', 'start', 'launch', 'restore session', 'home']

/** A page's label in the list: its address without the scheme or a lone trailing slash. */
function pageLabel(url: string): string {
  return displayUrl(url).replace(/\/$/, '')
}

/**
 * The open tabs' web addresses in the sidebar's order – Essentials first, then each Space's tabs
 * – each once, capped, for Use current pages; none from a private window, whose pages are not
 * to be written into a setting.
 */
export function currentPages(state: UIState): string[] {
  if (state.window.kind === 'private') return []
  const ids = [...state.essentialTabIds, ...state.spaces.flatMap((space) => space.tabIds)]
  return sanitizeStartupPages(ids.map((id) => state.tabs[id]?.url ?? ''))
}

export function startupGroup({ state, set }: Pick<SectionContext, 'state' | 'set'>): RowGroup {
  const own = state.settings.startup
  const modeControl = extensionControlled(state, 'startup.mode')
  const pagesControl = extensionControlled(state, 'startup.pages')
  const heldPages = Array.isArray(pagesControl?.value) ? pagesControl.value : null
  const mode: StartupMode = modeControl ? 'pages' : own.mode
  const pages = heldPages ?? own.pages
  const setPages = (next: string[]): void => set({ startup: { ...own, pages: next } })

  const rows: SettingsRow[] = [
    choice<StartupMode>({
      id: 'startup-mode',
      label: 'When Zenium starts',
      keywords: KEYWORDS,
      controlled: modeControl,
      value: mode,
      options: [
        { value: 'newTab', label: 'Open the New Tab page' },
        { value: 'continue', label: 'Continue where you left off' },
        { value: 'pages', label: 'Open a specific page or set of pages' }
      ],
      onChange: (next) => set({ startup: { ...own, mode: next } })
    })
  ]
  if (mode !== 'pages') return { id: 'startup', heading: 'On startup', rows }

  if (heldPages) {
    for (const [index, url] of heldPages.entries())
      rows.push({
        kind: 'info',
        id: `startup-page:${index}`,
        label: pageLabel(url),
        keywords: [url],
        controlled: pagesControl
      })
    return { id: 'startup', heading: 'On startup', rows }
  }

  for (const [index, url] of pages.entries()) {
    const id = `startup-page:${index}`
    rows.push({
      kind: 'item',
      id,
      label: pageLabel(url),
      keywords: [url, 'startup page'],
      menu: `Options for ${pageLabel(url)}`,
      sheet: {
        title: pageLabel(url),
        description: url,
        groups: [
          {
            id: `${id}-actions`,
            heading: null,
            rows: [
              {
                kind: 'action',
                id: `${id}:edit`,
                label: 'Edit',
                description: 'The address the tab opens on.',
                button: 'Edit…',
                form: {
                  title: 'Edit page',
                  render: (close) => (
                    <StartupPageForm
                      initial={url}
                      action="Save"
                      pages={pages}
                      index={index}
                      onSubmit={(next) => setPages(pages.map((p, i) => (i === index ? next : p)))}
                      close={close}
                    />
                  )
                }
              },
              {
                kind: 'action',
                id: `${id}:remove`,
                label: 'Remove',
                button: 'Remove',
                description: 'Takes the page out of the list; the tabs open now are left alone.',
                onPress: () => setPages(pages.filter((_, i) => i !== index))
              }
            ]
          }
        ]
      }
    })
  }
  if (pages.length === 0)
    rows.push({
      kind: 'info',
      id: 'startup-pages-empty',
      label: 'No pages yet',
      description: 'Zenium opens the New Tab page until you add one.'
    })

  const current = currentPages(state)
  // A private window's pages are not written into a setting (`currentPages`): the row is held
  // there with the reason and the way out, not the line that says "open pages first" while
  // pages stand open (the #525 lead check, C5).
  const privateWindow = state.window.kind === 'private'
  const full = pages.length >= MAX_STARTUP_PAGES
  rows.push(
    {
      kind: 'action',
      id: 'startup-add-page',
      label: 'Add a new page',
      description: full ? `The list holds ${MAX_STARTUP_PAGES} pages at most.` : undefined,
      keywords: KEYWORDS,
      disabled: full,
      button: 'Add…',
      form: {
        title: 'Add a new page',
        render: (close) => (
          <StartupPageForm
            action="Add"
            pages={pages}
            onSubmit={(next) => setPages([...pages, next])}
            close={close}
          />
        )
      }
    },
    {
      kind: 'action',
      id: 'startup-use-current',
      label: 'Use current pages',
      description: privateWindow
        ? 'Open the pages you want in a regular window first. Private windows are not used.'
        : current.length === 0
          ? 'Open the pages you want first.'
          : current.length === 1
            ? 'Replaces the list with the page open now.'
            : `Replaces the list with the ${current.length} pages open now.`,
      keywords: KEYWORDS,
      disabled: current.length === 0,
      button: 'Use current',
      onPress: () => setPages(current)
    }
  )
  return { id: 'startup', heading: 'On startup', rows }
}
