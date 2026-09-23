import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { parseInternalPageUrl } from '@shared/internalPages'
import {
  CHROMIUM_LICENCES_URL,
  licenceLine,
  matchesLicence,
  sortLicences,
  type LicenceEntry
} from '@shared/licences'
import type { Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { PageColumn, PageEmpty, PageGroup, PageSearchField, PageTitleBlock } from '../PageFrame'
import { walkRows } from '../rowKeys'
import { usePageSearch } from '../usePageSearch'

/**
 * The Licences page (`zen://licences`, Settings › About › Open-source licences; Chrome's
 * chrome://credits, settings-73): the open-source software the build carries, in the §10.1 page
 * frame – the title block, the §9.12 search field, then §9.21 rows, one per package, each
 * folding open on its licence text (a §9.22 twisty row: the row's button is its expander). The
 * list is the build's own (`scripts/licences.ts`, the lazy `virtual:zenium-licences` chunk):
 * what electron-builder packages on the desktop, what the Android chrome bundles there. Desktop
 * hosts open with an Engine group – Electron's own entry and a Chromium row that opens Electron's
 * credits document in a tab of its own (`CHROMIUM_LICENCES_URL`, served by the main process) –
 * while the Android chrome, running on the device's WebView, lists its packages alone. The
 * search filters by name, version and licence, and the URL follows it (`?q=`, replace) so a
 * restored tab comes back searching; the arrows walk the rows, Enter and Space fold, Ctrl+F is
 * the field's.
 */
export function LicencesPage({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<readonly LicenceEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const engine = state.platform !== 'android'

  useEffect(() => {
    let live = true
    loadLicences().then(
      (loaded) => live && setEntries(sortLicences(loaded)),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [])

  const { query, setQuery, text } = usePageSearch({
    urlQuery,
    push: (value) =>
      run('page.navigate', {
        tabId: tab.id,
        section: null,
        replace: true,
        query: value ? { q: value } : undefined
      })
  })

  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    field.current?.focus()
    field.current?.select()
    return true
  })

  const terms = text.toLowerCase().split(/\s+/).filter(Boolean)
  const toggle = (key: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const electron = engine ? entries?.find((e) => e.name === 'electron') : undefined
  const packages = entries?.filter((e) => e !== electron) ?? []
  const shown = packages.filter((e) => matchesLicence(e, text))
  const engineShown: LicenceEntry[] = engine
    ? [
        ...(electron && matchesLicence(electron, text) ? [electron] : []),
        ...(matchesLicence(CHROMIUM_ENTRY, text) ? [CHROMIUM_ENTRY] : [])
      ]
    : []

  const row = (entry: LicenceEntry): JSX.Element => (
    <LicenceRow
      key={keyOf(entry)}
      entry={entry}
      terms={terms}
      open={open.has(keyOf(entry))}
      onToggle={() => toggle(keyOf(entry))}
    />
  )

  return (
    <PageColumn
      testId="licences-page"
      className="zen-licences-page"
      header={
        <>
          <PageTitleBlock
            title="Licences"
            description="The open-source software Zenium is built with, and the licence each part comes under."
          />
          <PageSearchField
            field={field}
            value={query}
            onChange={setQuery}
            placeholder="Find a package"
            testId="licences-search"
          />
        </>
      }
    >
      <div ref={list} className="zen-page-list" onKeyDown={(e) => walkRows(e, list)}>
        {entries === null && !failed && (
          <p className="zen-page-group-empty" role="status" data-testid="licences-loading">
            Loading licences
          </p>
        )}
        {failed && (
          <PageEmpty testId="licences-failed">The licences list could not be loaded</PageEmpty>
        )}
        {entries !== null && engine && engineShown.length > 0 && (
          <PageGroup heading="Engine" headingId="zen-licences-engine" data-testid="licences-engine">
            <ul className="zen-page-rows">
              {engineShown.map((entry) =>
                entry === CHROMIUM_ENTRY ? (
                  <ChromiumRow key="chromium" terms={terms} tab={tab} />
                ) : (
                  row(entry)
                )
              )}
            </ul>
          </PageGroup>
        )}
        {entries !== null && (shown.length > 0 || engineShown.length === 0) && (
          <PageGroup
            heading="Packages"
            headingId="zen-licences-packages"
            aside={String(text ? shown.length : packages.length)}
            data-testid="licences-packages"
          >
            {shown.length > 0 ? (
              <ul className="zen-page-rows">{shown.map(row)}</ul>
            ) : (
              <PageEmpty testId="licences-empty">
                {text ? `No packages match “${text}”` : 'No packages are listed for this build'}
              </PageEmpty>
            )}
          </PageGroup>
        )}
      </div>
    </PageColumn>
  )
}

/**
 * The engine's row on desktop hosts: Chromium has no entry of its own in the build's list – its
 * credits are Electron's document, served by the main process – so the row stands in for it.
 */
const CHROMIUM_ENTRY: LicenceEntry = {
  name: 'Chromium',
  version: '',
  licence: 'BSD-3-Clause',
  url: 'https://www.chromium.org'
}

/** The build's list, its own chunk (`virtual:zenium-licences`, `scripts/licences.ts`). */
async function loadLicences(): Promise<readonly LicenceEntry[]> {
  const mod = await import('virtual:zenium-licences')
  return mod.default
}

function keyOf(entry: LicenceEntry): string {
  return `${entry.name}@${entry.version}`
}

/** The id of a row's fold, for `aria-controls`: the key with anything not an id character replaced. */
function foldId(entry: LicenceEntry): string {
  return `zen-licence-${keyOf(entry).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * One package: a two-line row (name over version · licence) whose button folds the licence text
 * open under it – the homepage as a §9.16 link that opens outside, then the file's text as it
 * came, or one line saying the package ships none.
 */
function LicenceRow({
  entry,
  terms,
  open,
  onToggle
}: {
  entry: LicenceEntry
  terms: string[]
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const id = foldId(entry)
  return (
    <li className="zen-licences-entry" data-open={open || undefined} data-package={entry.name}>
      <div className="zen-v2-row zen-page-row zen-licences-row">
        <button
          type="button"
          className="zen-page-row-text"
          data-row-focus=""
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={onToggle}
        >
          <span className="zen-page-row-label">{highlight(entry.name, terms)}</span>
          <span className="zen-page-row-desc">{highlight(licenceLine(entry), terms)}</span>
        </button>
        <ChevronRight
          className="zen-page-row-chevron zen-licences-twisty"
          data-open={open || undefined}
          aria-hidden
        />
      </div>
      {open && (
        <div className="zen-licences-fold" id={id}>
          {entry.url && (
            <a
              className="zen-v2-link zen-licences-homepage"
              href={entry.url}
              onClick={(e) => {
                e.preventDefault()
                run('app.openExternal', { url: entry.url! })
              }}
            >
              {displayUrl(entry.url)}
              <ExternalLink aria-hidden />
            </a>
          )}
          {entry.text ? (
            <pre className="zen-licences-text">{entry.text}</pre>
          ) : (
            <p className="zen-licences-text zen-licences-text-missing">
              {entry.licence
                ? `Released under ${entry.licence}; the package ships no licence file.`
                : 'The package declares no licence and ships no licence file.'}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/** Chromium's row: opens Electron's credits document in a tab beside this one. */
function ChromiumRow({ terms, tab }: { terms: string[]; tab: Tab }): JSX.Element {
  return (
    <li className="zen-licences-entry" data-package="chromium">
      <div className="zen-v2-row zen-page-row zen-licences-row">
        <button
          type="button"
          className="zen-page-row-text"
          data-row-focus=""
          data-testid="licences-chromium"
          onClick={() => run('tab.create', { url: CHROMIUM_LICENCES_URL, afterTabId: tab.id })}
        >
          <span className="zen-page-row-label">{highlight('Chromium', terms)}</span>
          <span className="zen-page-row-desc">
            The engine and the third-party code inside it, in Electron’s credits document
          </span>
        </button>
        <ChevronRight className="zen-page-row-chevron" aria-hidden />
      </div>
    </li>
  )
}

/** A homepage as the link reads it: no scheme, no trailing slash. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** The search's terms marked in a row's text (`<mark>`, the page's shared highlight). */
function highlight(text: string, terms: string[]): ReactNode {
  if (terms.length === 0 || !text) return text
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  const probe = new RegExp(`^(?:${escaped.join('|')})$`, 'i')
  const parts = text.split(pattern)
  if (parts.length === 1) return text
  return parts.map((part, i) => (probe.test(part) ? <mark key={i}>{part}</mark> : part))
}
