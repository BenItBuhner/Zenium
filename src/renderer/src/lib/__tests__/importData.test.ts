import { describe, expect, it } from 'vitest'
import type { ImportKindOutcome, ImportProgress, ImportSource } from '@shared/types'
import {
  FILE_SOURCE,
  IMPORT_READY,
  browserSources,
  defaultGroup,
  finishedImport,
  importedAnything,
  kindRows,
  limitNotes,
  listNames,
  outcomeLines,
  profileLabel,
  progressLine,
  reportedKinds,
  resultCaption,
  resultHeadline,
  runningNotice,
  sourceCaption,
  sourceGroups,
  summaryLine
} from '../importData'

/*
 * The import dialog's vocabulary (ID-23's UI) over the engine's `ImportSource` and
 * `ImportProgress`: the "From" menulist groups a browser's profiles behind one entry and keeps
 * the file sources apart, the profile labels tell twins apart by account, the running-browser
 * line is a notice for Chrome and Edge (read from a copy) and the refusal for Firefox, the
 * kind rows keep a kind the source cannot give as a disabled row with its limit, and the
 * result's words follow Chrome's ("Your bookmarks and settings are ready").
 */

function source(patch: Partial<ImportSource> & Pick<ImportSource, 'id' | 'browser'>): ImportSource {
  const names: Record<ImportSource['browser'], string> = {
    chrome: 'Google Chrome',
    chromium: 'Chromium',
    edge: 'Microsoft Edge',
    firefox: 'Firefox',
    safari: 'Safari',
    file: 'Bookmarks HTML file'
  }
  return {
    browserName: names[patch.browser],
    profileId: patch.id.split(':')[1] ?? '',
    name: names[patch.browser],
    path: `/home/u/.config/${patch.browser}/${patch.id.split(':')[1] ?? ''}`,
    running: false,
    kinds: ['bookmarks', 'history', 'passwords'],
    limits: {},
    ...patch
  }
}

const CHROME_1 = source({ id: 'chrome:Default', browser: 'chrome', name: 'Person 1' })
const CHROME_2 = source({
  id: 'chrome:Profile 2',
  browser: 'chrome',
  name: 'Person 1',
  email: 'bennett@example.com'
})
const FIREFOX = source({
  id: 'firefox:abcd.default-release',
  browser: 'firefox',
  kinds: ['bookmarks', 'history'],
  limits: {
    passwords:
      'Firefox keeps passwords in its own store. Export them as CSV in Firefox, then import the file.'
  }
})
const SAFARI = source({
  id: 'safari:default',
  browser: 'safari',
  kinds: ['bookmarks', 'history'],
  limits: {
    passwords:
      'Safari keeps passwords in the keychain. Export them from Safari, then import the file.'
  }
})
const HTML = source({
  id: FILE_SOURCE.bookmarks,
  browser: 'file',
  browserName: 'Bookmarks HTML file',
  name: 'Bookmarks HTML file',
  profileId: '',
  path: '',
  kinds: ['bookmarks']
})
const CSV = source({
  id: FILE_SOURCE.passwords,
  browser: 'file',
  browserName: 'Passwords CSV file',
  name: 'Passwords CSV file',
  profileId: '',
  path: '',
  kinds: ['passwords']
})

const ALL = [CHROME_1, CHROME_2, FIREFOX, SAFARI, HTML, CSV]

function outcome(patch: Partial<ImportKindOutcome> = {}): ImportKindOutcome {
  return { imported: 0, duplicates: 0, unreadable: 0, invalid: 0, error: null, ...patch }
}

function progress(patch: Partial<ImportProgress> = {}): ImportProgress {
  return {
    source: CHROME_1,
    kinds: ['bookmarks', 'history', 'passwords'],
    status: 'done',
    current: null,
    results: {},
    error: null,
    folderId: null,
    startedAt: 1,
    finishedAt: 2,
    ...patch
  }
}

describe('the From menulist', () => {
  it('groups a browser’s profiles behind one entry and keeps each file source its own', () => {
    const groups = sourceGroups(ALL)
    expect(groups.map((g) => [g.key, g.label, g.profiles.length])).toEqual([
      ['chrome', 'Google Chrome', 2],
      ['firefox', 'Firefox', 1],
      ['safari', 'Safari', 1],
      [FILE_SOURCE.bookmarks, 'Bookmarks HTML file', 1],
      [FILE_SOURCE.passwords, 'Passwords CSV file', 1]
    ])
    expect(groups[0]!.profiles).toEqual([CHROME_1, CHROME_2])
  })

  it('opens on the first browser found, else on the first file source', () => {
    expect(defaultGroup(sourceGroups(ALL))?.key).toBe('chrome')
    expect(defaultGroup(sourceGroups([HTML, CSV]))?.key).toBe(FILE_SOURCE.bookmarks)
    expect(defaultGroup([])).toBeNull()
  })

  it('the first-run offer names browsers only: the file sources are no offer', () => {
    expect(browserSources(ALL).map((s) => s.id)).toEqual([
      CHROME_1.id,
      CHROME_2.id,
      FIREFOX.id,
      SAFARI.id
    ])
    expect(browserSources([HTML, CSV])).toEqual([])
  })

  it('tells twin profiles apart by their account, then by the directory', () => {
    const twins = [CHROME_1, CHROME_2]
    expect(profileLabel(CHROME_1, twins)).toBe('Person 1 (Default)')
    expect(profileLabel(CHROME_2, twins)).toBe('Person 1 (bennett@example.com)')
    // A name of its own needs no suffix.
    expect(profileLabel(CHROME_2, [CHROME_2, { ...CHROME_1, name: 'Work' }])).toBe('Person 1')
    // A browser with one profile says only the account, if any.
    expect(sourceCaption(CHROME_2, [CHROME_2])).toBe('bennett@example.com')
    expect(sourceCaption(CHROME_1, [CHROME_1])).toBeNull()
    expect(sourceCaption(CHROME_1, twins)).toBe('Person 1 (Default)')
  })
})

describe('the notices a source carries', () => {
  it('a running Chrome or Edge is a notice with the way out; a running Firefox is the refusal', () => {
    expect(runningNotice(CHROME_1)).toBeNull()
    expect(runningNotice({ ...CHROME_1, running: true })).toBe(
      'Google Chrome is open. Zenium reads a copy of its data; if the import fails, close Google Chrome and try again.'
    )
    expect(runningNotice({ ...FIREFOX, running: true })).toBe(
      'Firefox is open. Close Firefox and try again.'
    )
    expect(runningNotice(null)).toBeNull()
  })

  it('the kind rows are the kinds the source has, then a disabled row per recorded limit, in the dialog’s order', () => {
    expect(kindRows(CHROME_1)).toEqual([
      { kind: 'bookmarks', available: true },
      { kind: 'history', available: true },
      { kind: 'passwords', available: true }
    ])
    expect(kindRows(FIREFOX)).toEqual([
      { kind: 'bookmarks', available: true },
      { kind: 'history', available: true },
      { kind: 'passwords', available: false }
    ])
    expect(kindRows(HTML)).toEqual([{ kind: 'bookmarks', available: true }])
    expect(kindRows(null)).toEqual([])
    expect(limitNotes(FIREFOX)).toEqual([{ kind: 'passwords', text: FIREFOX.limits.passwords }])
    expect(limitNotes(CHROME_1)).toEqual([])
  })
})

describe('the words for what an import did', () => {
  it('counts what came in first, then what was skipped and why, then the engine’s note', () => {
    expect(
      outcomeLines(
        'bookmarks',
        outcome({
          imported: 120,
          duplicates: 3,
          invalid: 1,
          note: 'Read from the bookmark backup of 12 September'
        })
      )
    ).toEqual([
      '120 bookmarks imported',
      '3 already saved, 1 unusable',
      'Read from the bookmark backup of 12 September'
    ])
    expect(outcomeLines('bookmarks', outcome({ imported: 1 }))).toEqual(['1 bookmark imported'])
    expect(outcomeLines('history', outcome({ imported: 0, duplicates: 40 }))).toEqual([
      'No new visits',
      '40 already in your history'
    ])
    expect(outcomeLines('passwords', outcome({ imported: 2, unreadable: 5 }))).toEqual([
      '2 passwords imported',
      '5 could not be opened'
    ])
    // The engine's keyring note already counts the unopened ones with the reason: said once.
    expect(
      outcomeLines(
        'passwords',
        outcome({
          imported: 2,
          unreadable: 1,
          note: '1 password could not be opened: they are protected by the system keyring, which could not be read.'
        })
      )
    ).toEqual([
      '2 passwords imported',
      '1 password could not be opened: they are protected by the system keyring, which could not be read.'
    ])
    // Counts read with digit grouping (the chrome's convention for item counts).
    expect(outcomeLines('history', outcome({ imported: 24000, duplicates: 1200 }))).toEqual([
      `${(24000).toLocaleString()} visits imported`,
      `${(1200).toLocaleString()} already in your history`
    ])
    // A kind that failed says why instead of counting.
    expect(outcomeLines('passwords', outcome({ error: 'The keyring kept its secret.' }))).toEqual([
      'The keyring kept its secret.'
    ])
  })

  it('reports the kinds that ran in the dialog’s order and knows whether anything came in', () => {
    const p = progress({
      results: { passwords: outcome({ imported: 0 }), bookmarks: outcome({ imported: 3 }) }
    })
    expect(reportedKinds(p)).toEqual(['bookmarks', 'passwords'])
    expect(importedAnything(p)).toBe(true)
    expect(importedAnything(progress({ results: { history: outcome() } }))).toBe(false)
  })

  it('the last import worth reporting has finished with something to say: not a run in flight, not a cancelled file pick', () => {
    const done = progress({ results: { bookmarks: outcome({ imported: 3 }) } })
    expect(finishedImport(done)).toBe(done)
    expect(finishedImport(progress({ status: 'running', finishedAt: null }))).toBeNull()
    expect(finishedImport(null)).toBeNull()
    // The picker dismissed: stopped before any kind ran, nothing to show.
    expect(finishedImport(progress({ status: 'cancelled' }))).toBeNull()
    // Stopped after a kind ran, or with a failure of its own: that is a result.
    const stopped = progress({
      status: 'cancelled',
      results: { bookmarks: outcome({ imported: 3 }) }
    })
    expect(finishedImport(stopped)).toBe(stopped)
    const failed = progress({ status: 'failed', error: 'The profile could not be read.' })
    expect(finishedImport(failed)).toBe(failed)
  })

  it('the busy line names the kind being read', () => {
    expect(progressLine(progress({ status: 'running', current: 'history' }))).toBe(
      'Importing browsing history…'
    )
    expect(progressLine(progress({ status: 'running', current: null }))).toBe('Importing…')
  })

  it('the headline is Chrome’s when something came in, the run’s failure, or "Nothing was imported"', () => {
    expect(resultHeadline(progress({ results: { bookmarks: outcome({ imported: 3 }) } }))).toBe(
      IMPORT_READY
    )
    expect(resultHeadline(progress({ results: { bookmarks: outcome({ duplicates: 3 }) } }))).toBe(
      'Nothing was imported'
    )
    expect(
      resultHeadline(
        progress({ status: 'failed', error: 'Firefox is open. Close Firefox and try again.' })
      )
    ).toBe('Firefox is open. Close Firefox and try again.')
    expect(resultHeadline(progress({ status: 'cancelled' }))).toBe('Import stopped')
  })

  it('the caption names the source: the browser with its profile, or the file', () => {
    expect(resultCaption(progress({ source: CHROME_1 }))).toBe('From Google Chrome (Person 1)')
    expect(resultCaption(progress({ source: FIREFOX }))).toBe('From Firefox')
    expect(resultCaption(progress({ source: HTML }))).toBe('From a bookmarks HTML file')
  })

  it('the one-line summary is each kind’s count line, or the failure', () => {
    expect(
      summaryLine(
        progress({
          results: { bookmarks: outcome({ imported: 3 }), history: outcome({ imported: 0 }) }
        })
      )
    ).toBe('3 bookmarks imported. No new visits')
    expect(summaryLine(progress({ error: 'The profile could not be read.' }))).toBe(
      'The profile could not be read.'
    )
    expect(summaryLine(progress())).toBe('Nothing was imported')
  })

  it('lists names as a sentence does', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['Google Chrome'])).toBe('Google Chrome')
    expect(listNames(['Google Chrome', 'Firefox'])).toBe('Google Chrome and Firefox')
    expect(listNames(['Google Chrome', 'Firefox', 'Safari'])).toBe(
      'Google Chrome, Firefox and Safari'
    )
  })
})
