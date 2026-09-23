// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'

/*
 * The About cluster's chrome pages (SET-54, SET-55): What's new on the shared page frame – the
 * title block naming the running version, "Release notes" in its trailing slot opening the
 * version's release page in a tab, the updater's highlights as prose, §9.17's sentence until a
 * check has brought them – and the two legal pages, the Privacy notice and the Terms, each its
 * text as prose under its title; a link in the prose opens as a tab of this browser, never a
 * navigation of the page.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { InternalPageHost } = await import('../../InternalPageHost')
const { PRIVACY_NOTICE, TERMS } = await import('../legalText')

function state(notes: { version: string; text: string } | null): UIState {
  return {
    version: '0.4.35',
    platform: 'android',
    updates: { phase: 'idle', notes },
    capabilities: { pageTabs: true },
    shortcuts: [],
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    tabs: {}
  } as unknown as UIState
}

function tab(url: string): Tab {
  return {
    id: 'page',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Page',
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    openerTabId: 'settings'
  } as unknown as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

async function mountPage(url: string, s: UIState): Promise<HTMLElement> {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(InternalPageHost, { state: s, tab: tab(url) })))
  return mount
}

beforeEach(() => {
  invoke.mockClear()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('What’s new', () => {
  it('draws the running version’s highlights as prose under the title block naming the version', async () => {
    const el = await mountPage(
      'zen://whats-new',
      state({
        version: '0.4.35',
        text: '- **Spaces** arrived, see [the guide](https://zenium.example/spaces).\n- The pill copies on a long-press.\n\n### Upgrading\nNothing to do.'
      })
    )
    const host = el.querySelector('.zen-page-host[data-page="whats-new"]')!
    expect(host.getAttribute('data-surface')).toBe('page')
    expect(el.querySelector('h1#whats-new-title')?.textContent).toBe('What’s new')
    expect(el.querySelector('.zen-page-title-desc')?.textContent).toBe('Zenium 0.4.35')
    const notes = el.querySelector('[data-testid="whats-new-notes"]')!
    expect(notes.classList.contains('zen-page-prose')).toBe(true)
    const items = [...notes.querySelectorAll('ul > li')].map((li) => li.textContent)
    expect(items).toEqual(['Spaces arrived, see the guide.', 'The pill copies on a long-press.'])
    expect(notes.querySelector('li > strong')?.textContent).toBe('Spaces')
    expect(notes.querySelector('h3.zen-page-prose-subheading')?.textContent).toBe('Upgrading')
    expect(notes.querySelector('p.zen-page-prose-p')?.textContent).toBe('Nothing to do.')
    expect(el.querySelector('[data-testid="whats-new-empty"]')).toBeNull()
  })

  it('opens a link in the notes as a tab of this browser, and Release notes the version’s release page', async () => {
    const el = await mountPage(
      'zen://whats-new',
      state({ version: '0.4.35', text: 'See https://zenium.example/notes.' })
    )
    const link = el.querySelector<HTMLAnchorElement>('.zen-page-prose a.zen-v2-link')!
    expect(link.getAttribute('href')).toBe('https://zenium.example/notes')
    await act(async () => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
    })
    expect(invoke).toHaveBeenCalledWith('tab.create', {
      url: 'https://zenium.example/notes',
      active: true
    })
    invoke.mockClear()
    const release = el.querySelector<HTMLButtonElement>('[data-testid="whats-new-release"]')!
    expect(release.textContent).toBe('Release notes')
    expect(release.classList.contains('zen-v2-button')).toBe(true)
    await act(async () => release.click())
    expect(invoke).toHaveBeenCalledWith('tab.create', {
      url: 'https://github.com/BenItBuhner/Zenium/releases/tag/v0.4.35',
      active: true
    })
  })

  it('shows §9.17’s one sentence until a check has brought the running version’s notes, the release page one tap off', async () => {
    const el = await mountPage('zen://whats-new', state(null))
    const empty = el.querySelector('[data-testid="whats-new-empty"]')!
    expect(empty.getAttribute('role')).toBe('status')
    expect(empty.textContent).toBe('The notes for this version come with the next update check')
    expect(el.querySelector('[data-testid="whats-new-notes"]')).toBeNull()
    expect(el.querySelector('[data-testid="whats-new-release"]')).not.toBeNull()
    // Notes of another version are not this build's.
    root!.unmount()
    root = null
    mount?.remove()
    const stale = await mountPage('zen://whats-new', state({ version: '0.4.34', text: '- Old' }))
    expect(stale.querySelector('[data-testid="whats-new-empty"]')).not.toBeNull()
  })
})

describe('the legal pages', () => {
  it('draws the Privacy notice as prose under its title, from the page’s own text', async () => {
    const el = await mountPage('zen://privacy-notice', state(null))
    expect(el.querySelector('.zen-page-host[data-page="privacy-notice"]')).not.toBeNull()
    expect(el.querySelector('h1#privacy-notice-title')?.textContent).toBe('Privacy notice')
    const text = el.querySelector('[data-testid="privacy-notice-text"]')!
    expect(text.classList.contains('zen-page-prose')).toBe(true)
    const headings = [...text.querySelectorAll('h2.zen-page-prose-heading')].map(
      (h) => h.textContent
    )
    expect(headings).toEqual([
      'What stays on your device',
      'What leaves your device',
      'Your choices'
    ])
    expect(text.querySelector('p')?.textContent).toBe(PRIVACY_NOTICE.split('\n')[0])
    expect(el.querySelector('.zen-page-title-actions')).toBeNull()
  })

  it('draws the Terms likewise, the licence’s address a link opening as a tab', async () => {
    const el = await mountPage('zen://terms', state(null))
    expect(el.querySelector('h1#terms-title')?.textContent).toBe('Terms')
    const text = el.querySelector('[data-testid="terms-text"]')!
    expect(text.querySelector('p')?.textContent).toBe(TERMS.split('\n')[0])
    const links = [...text.querySelectorAll('a.zen-v2-link')].map((a) => a.getAttribute('href'))
    expect(links).toEqual([
      'https://github.com/BenItBuhner/Zenium',
      'http://www.apache.org/licenses/LICENSE-2.0'
    ])
    await act(async () => text.querySelector<HTMLAnchorElement>('a.zen-v2-link')!.click())
    expect(invoke).toHaveBeenCalledWith('tab.create', {
      url: 'https://github.com/BenItBuhner/Zenium',
      active: true
    })
  })
})
