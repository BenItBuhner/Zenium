import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space, Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import {
  BackDismissal,
  backStore,
  dispatchBackEvent,
  pushBackSurface,
  rootBackAction,
  topBackSurface,
  type BackSurface
} from '../back'

function surface(name: string): BackSurface & { calls: string[] } {
  const calls: string[] = []
  return {
    name,
    calls,
    onStart: (edge) => calls.push(`start:${edge}`),
    onProgress: (p) => calls.push(`progress:${p}`),
    onCommit: () => calls.push('commit'),
    onCancel: () => calls.push('cancel')
  }
}

describe('back surface registry', () => {
  const pops: Array<() => void> = []
  afterEach(() => {
    while (pops.length) pops.pop()?.()
  })
  const push = (s: BackSurface): void => {
    pops.push(pushBackSurface(s))
  }

  it('the topmost surface owns the gesture from start to commit', () => {
    const below = surface('below')
    const top = surface('top')
    push(below)
    push(top)
    expect(topBackSurface()).toBe(top)
    expect(dispatchBackEvent('start', { edge: 'right' })).toBe(true)
    dispatchBackEvent('progress', { progress: 0.25 })
    expect(dispatchBackEvent('commit')).toBe(true)
    expect(top.calls).toEqual(['start:right', 'progress:0.25', 'commit'])
    expect(below.calls).toEqual([])
  })

  it('cancel springs the surface back and ends the gesture', () => {
    const s = surface('sheet')
    push(s)
    dispatchBackEvent('start', { edge: 'left' })
    dispatchBackEvent('progress', { progress: 0.5 })
    expect(dispatchBackEvent('cancel')).toBe(true)
    // No gesture in flight any more: progress has nothing to move.
    expect(dispatchBackEvent('progress', { progress: 0.9 })).toBe(false)
    expect(s.calls).toEqual(['start:left', 'progress:0.5', 'cancel'])
  })

  it('a commit without a start (back button) closes the top surface', () => {
    const s = surface('panel')
    push(s)
    expect(dispatchBackEvent('commit')).toBe(true)
    expect(s.calls).toEqual(['commit'])
  })

  it('a surface that went away mid-gesture is not committed, and nothing else is', () => {
    const below = surface('below')
    const top = surface('top')
    push(below)
    const popTop = pushBackSurface(top)
    dispatchBackEvent('start', { edge: 'left' })
    popTop()
    expect(dispatchBackEvent('commit')).toBe(true)
    expect(top.calls).toEqual(['start:left'])
    expect(below.calls).toEqual([])
  })

  it('progress is clamped to 0…1', () => {
    const s = surface('sheet')
    push(s)
    dispatchBackEvent('start', { edge: 'left' })
    dispatchBackEvent('progress', { progress: 1.7 })
    dispatchBackEvent('progress', { progress: -0.2 })
    expect(s.calls.slice(1)).toEqual(['progress:1', 'progress:0'])
  })

  it('with nothing registered and no browser state, a commit has nothing to do', () => {
    expect(dispatchBackEvent('start', { edge: 'left' })).toBe(false)
    expect(dispatchBackEvent('commit')).toBe(false)
  })

  it('tells the host whether the chrome would take a back', () => {
    expect(backStore.get().chrome).toBe(false)
    const pop = pushBackSurface(surface('sheet'))
    expect(backStore.get().chrome).toBe(true)
    pop()
    expect(backStore.get().chrome).toBe(false)
  })
})

describe('rootBackAction', () => {
  function tab(id: string, patch: Partial<Tab> = {}): Tab {
    return {
      id,
      spaceId: 's1',
      containerId: 'default',
      url: `https://${id}.example`,
      title: id,
      favicon: null,
      pinned: false,
      essential: false,
      pinnedUrl: null,
      customTitle: null,
      customIcon: null,
      windowId: null,
      folderId: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      audible: false,
      muted: false,
      discarded: false,
      frozen: false,
      cpuThrottle: 1,
      zoom: 1,
      splitGroupId: null,
      createdAt: 0,
      lastActiveAt: 0,
      errorCode: null,
      bookmarked: false,
      readerable: false,
      blockedCount: 0,
      openerTabId: null,
      fromIntent: false,
      ...patch
    }
  }

  /** One space holding `tabs` (in that order), the first one active. */
  function state(...tabs: Tab[]): UIState {
    const space: Space = {
      id: 's1',
      name: 'Default',
      icon: '',
      containerId: 'default',
      theme: null,
      tabIds: tabs.map((t) => t.id),
      activeTabId: tabs[0]?.id ?? null,
      pinnedCollapsed: false
    }
    return {
      tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
      essentialTabIds: [],
      spaces: [space],
      activeSpaceId: 's1',
      folders: {},
      settings: { containerSpecificEssentials: false }
    } as unknown as UIState
  }

  it('a child tab closes back to its opener while the opener is around', () => {
    const opener = tab('opener')
    const child = tab('child', { openerTabId: 'opener' })
    expect(rootBackAction(child, state(child, opener))).toBe('opener')
    // Opener gone: the child is an ordinary page at its root.
    expect(rootBackAction(child, state(child, tab('other')))).toBe('newTabPage')
  })

  it('a tab another app opened closes and hands the user back to that app', () => {
    const shared = tab('shared', { fromIntent: true })
    expect(rootBackAction(shared, state(shared, tab('other')))).toBe('caller')
    expect(rootBackAction(shared, state(shared))).toBe('caller')
    // Opened from a link inside a tab that itself came from an intent: the opener wins.
    const child = tab('child', { fromIntent: true, openerTabId: 'shared' })
    expect(rootBackAction(child, state(child, shared))).toBe('opener')
  })

  it('a page at its root gives way to a new-tab page, in the same tab slot', () => {
    const page = tab('page')
    expect(rootBackAction(page, state(page))).toBe('newTabPage')
    expect(rootBackAction(page, state(page, tab('other')))).toBe('newTabPage')
  })

  it('a new-tab page closes to the previous tab, unless it is the last one', () => {
    const blank = tab('blank', { url: BLANK_URL })
    expect(rootBackAction(blank, state(blank, tab('other')))).toBe('closeTab')
    expect(rootBackAction(blank, state(blank))).toBe('background')
    // An essential in the space still counts as somewhere to go.
    const essential = tab('essential', { spaceId: null, essential: true })
    const withEssential = {
      ...state(blank),
      tabs: { blank, essential },
      essentialTabIds: ['essential']
    } as UIState
    expect(rootBackAction(blank, withEssential)).toBe('closeTab')
  })

  it('pinned and essential tabs stay: the app goes to the background', () => {
    const pinned = tab('pinned', { pinned: true })
    expect(rootBackAction(pinned, state(pinned, tab('other')))).toBe('background')
    const essential = tab('essential', { spaceId: null, essential: true })
    expect(rootBackAction(essential, state(essential, tab('other')))).toBe('background')
  })
})

describe('BackDismissal', () => {
  let frames: Array<(now: number) => void>
  let now: number

  /** Run queued animation frames until the spring rests (or `max` frames pass). */
  const settle = (max = 400): void => {
    for (let i = 0; i < max && frames.length; i++) {
      now += 16
      const batch = frames
      frames = []
      for (const frame of batch) frame(now)
    }
  }

  beforeEach(() => {
    frames = []
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.splice(id - 1, 1)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('paints the finger position directly and finishes the slide on commit', () => {
    const painted: number[] = []
    let dismissed = 0
    const d = new BackDismissal({
      render: (v) => painted.push(v),
      dismissed: () => dismissed++
    })
    d.start()
    d.setProgress(0.3)
    expect(painted).toEqual([0.3])
    expect(d.progress).toBe(0.3)
    d.commit()
    expect(dismissed).toBe(0)
    settle()
    expect(dismissed).toBe(1)
    expect(painted[painted.length - 1]).toBe(1)
    // Monotonic: the sheet never comes back on its way out.
    for (let i = 1; i < painted.length; i++)
      expect(painted[i]).toBeGreaterThanOrEqual(painted[i - 1])
  })

  it('cancel springs back to fully shown without dismissing', () => {
    const painted: number[] = []
    let dismissed = 0
    const d = new BackDismissal({
      render: (v) => painted.push(v),
      dismissed: () => dismissed++
    })
    d.start()
    d.setProgress(0.6)
    d.cancel()
    settle()
    expect(dismissed).toBe(0)
    expect(d.progress).toBe(0)
  })

  it('a new gesture takes over from a spring that is still running', () => {
    const painted: number[] = []
    const d = new BackDismissal({ render: (v) => painted.push(v), dismissed: () => undefined })
    d.start()
    d.setProgress(0.8)
    d.cancel()
    settle(3)
    const midway = d.progress
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(0.8)
    d.start()
    expect(frames).toEqual([]) // the spring stopped where it was
    expect(d.progress).toBe(midway)
    d.setProgress(0.9)
    expect(d.progress).toBe(0.9)
  })

  it('a commit from rest still animates out, then dismisses once', () => {
    let dismissed = 0
    const d = new BackDismissal({ render: () => undefined, dismissed: () => dismissed++ })
    d.commit()
    expect(dismissed).toBe(0)
    settle()
    expect(dismissed).toBe(1)
    expect(d.progress).toBe(1)
  })
})
