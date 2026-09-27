// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The bar's Home item and the homepage (TB-15 / SET-36): the item is drawn only while a
 * homepage is set – Chrome's Home button leaves the toolbar with the homepage – while the
 * editor keeps offering it and a layout keeps it for when the homepage is back; a tap runs the
 * core's `tab.home`, which reads the setting.
 *
 * The bar's Tabs item and the in-product help record (TB-19): the button's tap is Chrome's
 * `tab_switcher_button_clicked`, the tab switcher bubble's `used` event – the one place the
 * chrome wires it – so the tap spends an unshown record as it opens the overview.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

// The overview's opening is the stage's (a spring over the pages); here only that the tap asks
// for it – the rest of the module stands.
vi.mock('@renderer/lib/gestures/stage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/gestures/stage')>()),
  toggleOverview: vi.fn()
}))

const { toggleOverview } = await import('@renderer/lib/gestures/stage')
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

/** A phone past its first run with the tab switcher bubble's record as given. */
function withRecord(record: UIState['settings']['iph']['tabSwitcher']): UIState {
  const base = state({ mode: 'off', url: '' })
  return {
    ...base,
    settings: { ...base.settings, onboardingDone: true, iph: { tabSwitcher: record } }
  }
}

const settingsUpdates = (): unknown[] =>
  invoke.mock.calls.filter((c) => c[0] === 'settings.update').map((c) => c[1])

beforeEach(() => {
  invoke.mockClear()
  vi.mocked(toggleOverview).mockClear()
})

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

describe('the bar’s Tabs item and the tab switcher bubble’s record (TB-19)', () => {
  const tab = { id: 't1', url: 'https://example.com/' } as Tab
  const STAMP = 1_800_000_000_000

  it('a tap spends an unshown record – Chrome’s used event – and opens the overview, in one', () => {
    const s = withRecord({ availableAt: STAMP, shown: false })
    BAR_ITEMS.tabs.run({ state: s, tab, overviewOpen: false })
    expect(settingsUpdates()).toEqual([
      { iph: { tabSwitcher: { availableAt: STAMP, shown: true } } }
    ])
    expect(toggleOverview).toHaveBeenCalledWith(s)
  })

  it('writes nothing for a record already shown, and still opens the overview', () => {
    const s = withRecord({ availableAt: STAMP, shown: true })
    BAR_ITEMS.tabs.run({ state: s, tab, overviewOpen: false })
    expect(settingsUpdates()).toEqual([])
    expect(toggleOverview).toHaveBeenCalledWith(s)
  })

  it('writes nothing before the first run is over (the record is not yet the user’s)', () => {
    const s = withRecord({ availableAt: null, shown: false })
    s.settings.onboardingDone = false
    BAR_ITEMS.tabs.run({ state: s, tab, overviewOpen: false })
    expect(settingsUpdates()).toEqual([])
  })
})
