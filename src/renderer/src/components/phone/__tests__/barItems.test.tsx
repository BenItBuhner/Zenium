// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The bar's Home item and the homepage (TB-15 / SET-36): the item is drawn only while a
 * homepage is set – Chrome's Home button leaves the toolbar with the homepage – while the
 * editor keeps offering it and a layout keeps it for when the homepage is back; a tap runs the
 * core's `tab.home`, which reads the setting.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { BAR_ITEMS, barCatalogue, barLayout } = await import('../barItems')

const WITH_HOME = { left: ['back', 'home'], right: ['new-tab', 'tabs', 'menu'] } as const

function state(homepage: UIState['settings']['homepage']): UIState {
  return {
    platform: 'android',
    capabilities: { share: true, voiceSearch: false },
    tabs: {},
    spaces: [],
    activeSpaceId: 'space',
    settings: {
      ...DEFAULT_SETTINGS,
      homepage,
      phoneBar: { left: [...WITH_HOME.left], right: [...WITH_HOME.right] }
    }
  } as unknown as UIState
}

beforeEach(() => invoke.mockClear())

describe('the bar’s Home item and the homepage', () => {
  it('is drawn while the homepage is the new tab page or a page, and leaves the bar while Off', () => {
    expect(barLayout(state({ mode: 'newtab', url: '' }))).toEqual(WITH_HOME)
    expect(barLayout(state({ mode: 'url', url: 'https://news.example/' }))).toEqual(WITH_HOME)
    expect(barLayout(state({ mode: 'off', url: '' }))).toEqual({
      left: ['back'],
      right: ['new-tab', 'tabs', 'menu']
    })
  })

  it('stays in the layout and the editor’s catalogue while Off – back when the homepage is', () => {
    const off = state({ mode: 'off', url: '' })
    expect(off.settings.phoneBar.left).toEqual(['back', 'home'])
    expect(barCatalogue(off)).toContain('home')
    // Voice search is not this host's, whatever the homepage: the catalogue is the host's.
    expect(barCatalogue(off)).not.toContain('voice')
  })

  it('a tap goes Home through the core, which reads the setting', () => {
    const tab = { id: 't1', url: 'https://example.com/' } as Tab
    BAR_ITEMS.home.run({ state: state({ mode: 'newtab', url: '' }), tab, overviewOpen: false })
    expect(invoke).toHaveBeenCalledWith('tab.home', { tabId: 't1' })
    expect(BAR_ITEMS.home.label).toBe('Home')
  })
})
