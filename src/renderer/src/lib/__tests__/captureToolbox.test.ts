// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevtoolsDock, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

import { cmd } from '../api'
import { browserStore } from '../browserStore'
import { captureActiveTab, uiStore } from '../ui'

/*
 * The cover under a menu keeps a docked developer toolbox (design language v2 §9.29): with the
 * tab's toolbox docked in the frame's box, the capture asks the host for the toolbox's picture
 * beside the page's and holds both; with none docked there – closed, undocked, another tab's –
 * the page's picture alone is asked for, as before.
 */

const PAGE = 'data:image/jpeg;base64,PAGE'
const TOOLBOX = 'data:image/jpeg;base64,TOOLBOX'

function state(devtools: Partial<Record<'t1' | 't2', DevtoolsDock>>, open: string[]): UIState {
  const tab = (id: 't1' | 't2'): Tab =>
    ({
      id,
      spaceId: 's1',
      containerId: 'default',
      url: `https://${id}.example`,
      splitGroupId: null,
      ...(devtools[id] ? { devtools: { dock: devtools[id] } } : {})
    }) as Tab
  return {
    platform: 'electron',
    tabs: { t1: tab('t1'), t2: tab('t2') },
    spaces: [
      { id: 's1', name: 'Work', containerId: 'default', tabIds: ['t1', 't2'], activeTabId: 't1' }
    ],
    activeSpaceId: 's1',
    splitGroups: {},
    devtoolsOpenFor: open,
    settings: { ...DEFAULT_SETTINGS },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

const asked = (): string[] => vi.mocked(cmd).mock.calls.map(([name]) => name as string)

beforeEach(() => {
  vi.mocked(cmd).mockImplementation(((name: string) =>
    Promise.resolve(name === 'overlay.snapshotDevtools' ? TOOLBOX : PAGE)) as never)
})

afterEach(() => {
  uiStore.set({ snapshot: null, snapshotTabId: null, toolboxSnapshot: null })
  browserStore.set({ state: null })
  vi.clearAllMocks()
})

describe('the capture under a docked toolbox (§9.29)', () => {
  it('asks for the toolbox’s picture beside the page’s while the tab’s toolbox is docked in the frame, and holds both', async () => {
    for (const dock of ['bottom', 'right', 'left'] as const) {
      browserStore.set({ state: state({ t1: dock }, ['t1']) })
      await captureActiveTab('t1')
      expect(asked()).toEqual(['overlay.snapshot', 'overlay.snapshotDevtools'])
      expect(cmd).toHaveBeenCalledWith('overlay.snapshotDevtools', { tabId: 't1' })
      expect(uiStore.get()).toMatchObject({
        snapshot: PAGE,
        snapshotTabId: 't1',
        toolboxSnapshot: TOOLBOX
      })
      uiStore.set({ snapshot: null, snapshotTabId: null, toolboxSnapshot: null })
      vi.clearAllMocks()
    }
  })

  it('asks for the page alone with no toolbox docked in the tab’s box: closed, undocked, or another tab’s', async () => {
    for (const s of [
      state({}, []),
      state({ t1: 'undocked' }, ['t1']),
      state({ t2: 'bottom' }, ['t2'])
    ]) {
      browserStore.set({ state: s })
      await captureActiveTab('t1')
      expect(asked()).toEqual(['overlay.snapshot'])
      expect(uiStore.get()).toMatchObject({
        snapshot: PAGE,
        snapshotTabId: 't1',
        toolboxSnapshot: null
      })
      uiStore.set({ snapshot: null, snapshotTabId: null, toolboxSnapshot: null })
      vi.clearAllMocks()
    }
    // Before the browser state has arrived there is no toolbox to ask about.
    browserStore.set({ state: null })
    await captureActiveTab('t1')
    expect(asked()).toEqual(['overlay.snapshot'])
  })

  it('passes `fresh` to both, keeps the page’s picture with a toolbox the host could not picture, and drops both on release', async () => {
    browserStore.set({ state: state({ t1: 'bottom' }, ['t1']) })
    vi.mocked(cmd).mockImplementation(((name: string) =>
      name === 'overlay.snapshotDevtools'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(PAGE)) as never)
    await captureActiveTab('t1', { fresh: true })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1', fresh: true })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshotDevtools', { tabId: 't1', fresh: true })
    expect(uiStore.get()).toMatchObject({
      snapshot: PAGE,
      snapshotTabId: 't1',
      toolboxSnapshot: null
    })
    await captureActiveTab(null)
    expect(uiStore.get()).toMatchObject({
      snapshot: null,
      snapshotTabId: null,
      toolboxSnapshot: null
    })
  })
})
