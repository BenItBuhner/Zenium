import { describe, expect, it } from 'vitest'
import type { Tab } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import {
  filterTabs,
  foldSearchText,
  normalizeQuery,
  searchResultAnnouncement,
  tabMatchesQuery
} from '../overviewSearch'
import { tabsOnPane } from '../privateTabs'

/*
 * The overview's tab search (TAB-21): a plain filter over the pane's open tabs by title and
 * address, case and diacritics folded, every word of the query somewhere in the tab; what the
 * pane keeps, and what TalkBack is told of the count.
 */

function tab(id: string, title: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    title,
    url,
    customTitle: null,
    containerId: 'default',
    ...patch
  } as Tab
}

const github = tab('gh', 'GitHub · Pull requests', 'https://github.com/zen/pulls')
const cafe = tab('cafe', 'Café Müller – Speisekarte', 'https://www.cafe-mueller.de/karte')
const news = tab('news', 'Hacker News', 'https://news.ycombinator.com/')
const docs = tab('docs', 'MDN Web Docs', 'https://developer.mozilla.org/en-US/docs/Web/API')
const all = [github, cafe, news, docs]

describe('foldSearchText', () => {
  it('lower-cases and drops the accents, leaving the base letters', () => {
    expect(foldSearchText('Café Müller')).toBe('cafe muller')
    expect(foldSearchText('ŁÓDŹ')).toBe('łodz')
    expect(foldSearchText('plain')).toBe('plain')
  })
})

describe('tabMatchesQuery', () => {
  it('matches the title, case aside', () => {
    expect(tabMatchesQuery(github, 'pull')).toBe(true)
    expect(tabMatchesQuery(github, 'PULL REQUESTS')).toBe(true)
    expect(tabMatchesQuery(news, 'pull')).toBe(false)
  })

  it('matches the address as typed and as shown, the scheme and www. off', () => {
    expect(tabMatchesQuery(github, 'github.com/zen')).toBe(true)
    expect(tabMatchesQuery(github, 'https://github')).toBe(true)
    expect(tabMatchesQuery(cafe, 'cafe-mueller.de')).toBe(true)
    expect(tabMatchesQuery(docs, 'developer.mozilla')).toBe(true)
    expect(tabMatchesQuery(docs, 'ycombinator')).toBe(false)
  })

  it('folds diacritics both ways', () => {
    expect(tabMatchesQuery(cafe, 'cafe')).toBe(true)
    expect(tabMatchesQuery(cafe, 'CAFÉ')).toBe(true)
    expect(tabMatchesQuery(cafe, 'muller')).toBe(true)
    expect(tabMatchesQuery(cafe, 'müller')).toBe(true)
    // A query with an accent finds a title without one too.
    expect(tabMatchesQuery(tab('x', 'Cafe corner', 'https://x.example/'), 'café')).toBe(true)
  })

  it('takes every word of the query, in any order, across title and address', () => {
    expect(tabMatchesQuery(github, 'requests github')).toBe(true)
    expect(tabMatchesQuery(github, 'pulls requests')).toBe(true)
    expect(tabMatchesQuery(github, 'pull mozilla')).toBe(false)
  })

  it('reads a custom title over the page title', () => {
    const renamed = tab('r', 'Untitled', 'https://r.example/', { customTitle: 'Budget 2026' })
    expect(tabMatchesQuery(renamed, 'budget')).toBe(true)
    expect(tabMatchesQuery(renamed, 'untitled')).toBe(false)
  })

  it('matches every tab for an empty or blank query', () => {
    expect(tabMatchesQuery(news, '')).toBe(true)
    expect(tabMatchesQuery(news, '   ')).toBe(true)
  })

  it('does not match scattered letters (a filter, not the omnibox)', () => {
    expect(tabMatchesQuery(github, 'gh')).toBe(false)
  })
})

describe('filterTabs', () => {
  it('keeps the matching tabs in their order', () => {
    expect(filterTabs(all, 'e').map((t) => t.id)).toEqual(['gh', 'cafe', 'news', 'docs'])
    expect(filterTabs(all, 'news').map((t) => t.id)).toEqual(['news'])
    expect(filterTabs(all, 'nothing here').map((t) => t.id)).toEqual([])
  })

  it('returns every tab for no query', () => {
    expect(filterTabs(all, '')).toEqual(all)
    expect(filterTabs(all, '  ')).toEqual(all)
  })

  it("narrows the pane's own tabs only: the private pane's query never reaches the regular ones", () => {
    const privateTab = tab('p', 'GitHub private', 'https://github.com/private', {
      containerId: PRIVATE_CONTAINER_ID
    })
    const mixed = [...all, privateTab]
    expect(filterTabs(tabsOnPane(mixed, 'private'), 'github').map((t) => t.id)).toEqual(['p'])
    expect(filterTabs(tabsOnPane(mixed, 'tabs'), 'github').map((t) => t.id)).toEqual(['gh'])
  })
})

describe('searchResultAnnouncement', () => {
  it('counts the cards left, once something is typed', () => {
    expect(searchResultAnnouncement('git', 3)).toBe('3 tabs found')
    expect(searchResultAnnouncement('git', 1)).toBe('1 tab found')
    expect(searchResultAnnouncement('git', 0)).toBe('No tabs found')
  })

  it('says nothing for an empty query', () => {
    expect(searchResultAnnouncement('', 4)).toBeNull()
    expect(searchResultAnnouncement('  ', 4)).toBeNull()
  })
})

describe('normalizeQuery', () => {
  it('trims', () => {
    expect(normalizeQuery('  git  ')).toBe('git')
    expect(normalizeQuery('   ')).toBe('')
  })
})
