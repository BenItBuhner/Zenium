import { Globe, Download, BookOpen, WifiOff } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bandClockLeft,
  bandStore,
  chooseBand,
  dismissBand,
  dismissBandByKey,
  dismissTabBands,
  holdBand,
  pickBandAction,
  resetBands,
  setBandFrame,
  showBand,
  shownBand,
  type BandDismissReason
} from '../band'
import { BAND_CLOCK_MS } from '../motion/tokens'

beforeEach(() => {
  vi.useFakeTimers()
  resetBands()
  setBandFrame({ front: 't1', ok: true })
})

afterEach(() => {
  resetBands()
  vi.useRealTimers()
})

const install = (tabId = 't1', onDismiss?: (r: BandDismissReason) => void): number =>
  showBand({
    key: `install:${tabId}`,
    form: 'offer',
    tabId,
    icon: Download,
    title: 'Install app',
    action: { label: 'Install', onPick: () => undefined },
    onDismiss
  })

const reader = (tabId = 't1', onDismiss?: (r: BandDismissReason) => void): number =>
  showBand({
    key: `reader:${tabId}`,
    form: 'offer',
    tabId,
    icon: BookOpen,
    title: 'Show Reader View?',
    action: { label: 'Show', onPick: () => undefined },
    onDismiss
  })

const defaultBrowser = (onDismiss?: (r: BandDismissReason) => void): number =>
  showBand({
    key: 'default-browser',
    form: 'state',
    icon: Globe,
    title: 'Make Zenium your default browser',
    action: { label: 'Set as default', onPick: () => undefined, holds: true },
    closeLabel: 'Not now',
    onDismiss
  })

const offline = (): number =>
  showBand({ key: 'connectivity', form: 'state', icon: WifiOff, title: 'You are offline' })

describe('the band model (motion spec §3.2)', () => {
  it('shows one band at a time: a newer offer replaces the standing offer, which hears "replaced"', () => {
    const heard: BandDismissReason[] = []
    const a = install('t1', (r) => heard.push(r))
    expect(shownBand()?.id).toBe(a)
    const b = reader('t1')
    expect(shownBand()?.id).toBe(b)
    expect(heard).toEqual(['replaced'])
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([b])
  })

  it('the same key again replaces its earlier self, whatever the form', () => {
    const heard: BandDismissReason[] = []
    const a = defaultBrowser((r) => heard.push(r))
    const b = defaultBrowser()
    expect(heard).toEqual(['replaced'])
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([b])
    expect(a).not.toBe(b)
  })

  it('a state stands over an offer; among states the newest shows and the older waits, not dismissed', () => {
    const heard: BandDismissReason[] = []
    const offer = install('t1', (r) => heard.push(r))
    const db = defaultBrowser()
    expect(shownBand()?.id).toBe(db)
    expect(heard).toEqual([])
    const off = offline()
    expect(shownBand()?.id).toBe(off)
    expect(bandStore.get().entries).toHaveLength(3)
    dismissBand(off)
    expect(shownBand()?.id).toBe(db)
    dismissBandByKey('default-browser', 'close')
    expect(shownBand()?.id).toBe(offer)
    expect(heard).toEqual([])
  })

  it('an offer stands BAND_CLOCK_MS and goes on "timeout"; a state has no clock', () => {
    const heard: BandDismissReason[] = []
    const a = install('t1', (r) => heard.push(r))
    expect(bandClockLeft(a)).toBe(BAND_CLOCK_MS)
    vi.advanceTimersByTime(BAND_CLOCK_MS - 1)
    expect(shownBand()?.id).toBe(a)
    vi.advanceTimersByTime(1)
    expect(shownBand()).toBeNull()
    expect(heard).toEqual(['timeout'])
    const db = defaultBrowser()
    vi.advanceTimersByTime(BAND_CLOCK_MS * 10)
    expect(shownBand()?.id).toBe(db)
    expect(bandClockLeft(db)).toBeNull()
  })

  it('the clock pauses under a finger and resumes with at least a moment; it never ends an offer being touched', () => {
    const a = install()
    vi.advanceTimersByTime(BAND_CLOCK_MS - 200)
    holdBand(true)
    expect(bandClockLeft(a)).toBe(200)
    vi.advanceTimersByTime(60_000)
    expect(shownBand()?.id).toBe(a)
    expect(bandClockLeft(a)).toBe(200)
    holdBand(false)
    expect(bandClockLeft(a)).toBe(1000)
    vi.advanceTimersByTime(999)
    expect(shownBand()?.id).toBe(a)
    vi.advanceTimersByTime(1)
    expect(shownBand()).toBeNull()
  })

  it('an offer waiting under a state has no clock running; it starts when the state goes', () => {
    const offer = install()
    vi.advanceTimersByTime(1000)
    expect(bandClockLeft(offer)).toBe(BAND_CLOCK_MS - 1000)
    const db = defaultBrowser()
    expect(shownBand()?.id).toBe(db)
    expect(bandClockLeft(offer)).toBe(BAND_CLOCK_MS - 1000)
    vi.advanceTimersByTime(30_000)
    expect(bandClockLeft(offer)).toBe(BAND_CLOCK_MS - 1000)
    dismissBand(db, 'close')
    expect(shownBand()?.id).toBe(offer)
    expect(bandClockLeft(offer)).toBe(BAND_CLOCK_MS - 1000)
    vi.advanceTimersByTime(BAND_CLOCK_MS - 1000)
    expect(shownBand()).toBeNull()
  })

  it('is per tab: a tab-scoped band leaves with its tab (clock paused) and returns with the time it had; a window-wide one stands on every tab', () => {
    const a = install('t1')
    const db = defaultBrowser()
    dismissBand(db)
    vi.advanceTimersByTime(4000)
    setBandFrame({ front: 't2', ok: true })
    expect(shownBand()).toBeNull()
    expect(bandClockLeft(a)).toBe(BAND_CLOCK_MS - 4000)
    vi.advanceTimersByTime(60_000)
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([a])
    const wide = offline()
    expect(shownBand()?.id).toBe(wide)
    setBandFrame({ front: 't1', ok: true })
    // The state stands here too; the offer waits beneath it.
    expect(shownBand()?.id).toBe(wide)
    dismissBand(wide)
    expect(shownBand()?.id).toBe(a)
    expect(bandClockLeft(a)).toBe(BAND_CLOCK_MS - 4000)
    vi.advanceTimersByTime(BAND_CLOCK_MS - 4000)
    expect(shownBand()).toBeNull()
  })

  it('offers of different tabs do not replace each other; a navigation takes a tab’s bands and no other’s', () => {
    const heard: Array<[string, BandDismissReason]> = []
    const a = install('t1', (r) => heard.push(['a', r]))
    const b = install('t2', (r) => heard.push(['b', r]))
    expect(heard).toEqual([])
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([b, a])
    const db = defaultBrowser((r) => heard.push(['db', r]))
    dismissTabBands('t1')
    expect(heard).toEqual([['a', 'navigation']])
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([db, b])
  })

  it('a window-wide offer replaces a tab’s offer and a tab’s offer replaces a window-wide one: one band in the scope', () => {
    const heard: Array<[string, BandDismissReason]> = []
    install('t1', (r) => heard.push(['a', r]))
    const wide = showBand({
      key: 'wide-offer',
      form: 'offer',
      icon: Download,
      title: 'Install app',
      onDismiss: (r) => heard.push(['wide', r])
    })
    expect(heard).toEqual([['a', 'replaced']])
    expect(shownBand()?.id).toBe(wide)
    const b = reader('t2', (r) => heard.push(['b', r]))
    expect(heard).toEqual([
      ['a', 'replaced'],
      ['wide', 'replaced']
    ])
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([b])
  })

  it('the host withholds the band (new tab page, chrome page, a dialog standing, the keyboard up): it waits, clock paused, and shows when allowed', () => {
    const a = install()
    vi.advanceTimersByTime(2500)
    setBandFrame({ front: 't1', ok: false })
    expect(shownBand()).toBeNull()
    expect(chooseBand(bandStore.get())).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([a])
    setBandFrame({ front: 't1', ok: true })
    expect(shownBand()?.id).toBe(a)
    expect(bandClockLeft(a)).toBe(BAND_CLOCK_MS - 2500)
  })

  it('under a cover (a sheet, a dialog, the keyboard) a prompt arriving waits and the one standing stays: it waits, it does not stack', () => {
    const a = install()
    expect(shownBand()?.id).toBe(a)
    // The cover comes over the standing offer: it stays, its clock running on.
    setBandFrame({ front: 't1', ok: true, covered: true })
    expect(shownBand()?.id).toBe(a)
    expect(bandStore.get().shown).toBe(a)
    expect(bandClockLeft(a)).toBe(BAND_CLOCK_MS)
    // A state arriving under the cover waits – the offer standing is not swapped out beneath it.
    const db = defaultBrowser()
    expect(shownBand()?.id).toBe(a)
    // The standing one gone, what waits keeps waiting (the frame has nothing until the cover goes).
    dismissBand(a, 'close')
    expect(shownBand()).toBeNull()
    expect(bandStore.get().shown).toBeNull()
    const off = offline()
    expect(shownBand()).toBeNull()
    // The cover goes: the newest state stands.
    setBandFrame({ front: 't1', ok: true })
    expect(shownBand()?.id).toBe(off)
    dismissBand(off)
    expect(shownBand()?.id).toBe(db)
  })

  it('under a cover the standing prompt stays only while it is the frame’s: another tab in front, or a private tab for an offer, takes it', () => {
    const a = install('t1')
    setBandFrame({ front: 't1', ok: true, covered: true })
    expect(shownBand()?.id).toBe(a)
    setBandFrame({ front: 't2', ok: true, covered: true })
    expect(shownBand()).toBeNull()
    setBandFrame({ front: 't1', ok: true, covered: true })
    // Back under the same cover: it was not shown when the frame last changed, so it waits.
    expect(shownBand()).toBeNull()
    setBandFrame({ front: 't1', ok: true })
    expect(shownBand()?.id).toBe(a)
    setBandFrame({ front: 't1', ok: true, offers: false, covered: true })
    expect(shownBand()).toBeNull()
  })

  it('the scene rides with the frame: the tab in front unless the host says more, in the one snapshot the band reads', () => {
    expect(bandStore.get().scene).toBe('t1')
    setBandFrame({ front: 't2', ok: true })
    expect(bandStore.get().scene).toBe('t2')
    setBandFrame({ front: 't2', ok: false, scene: 't2:fullscreen' })
    expect(bandStore.get().scene).toBe('t2:fullscreen')
    expect(shownBand()).toBeNull()
    // The same word again writes nothing: no listener hears it.
    const listener = vi.fn()
    const off = bandStore.subscribe(listener)
    setBandFrame({ front: 't2', ok: false, scene: 't2:fullscreen' })
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('a private tab withholds offers (they wait, clock paused) and shows states; the offers return with a tab that allows them', () => {
    const a = install()
    vi.advanceTimersByTime(1000)
    setBandFrame({ front: 't1', ok: true, offers: false })
    expect(shownBand()).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(bandStore.get().entries.map((e) => e.id)).toEqual([a])
    const s = offline()
    expect(shownBand()?.id).toBe(s)
    dismissBand(s)
    setBandFrame({ front: 't1', ok: true })
    expect(shownBand()?.id).toBe(a)
    expect(bandClockLeft(a)).toBe(BAND_CLOCK_MS - 1000)
  })

  it('the action performs and the band leaves on "action"; an act that holds keeps the band standing', () => {
    const picked = vi.fn()
    const heard: BandDismissReason[] = []
    const a = showBand({
      key: 'install:t1',
      form: 'offer',
      tabId: 't1',
      icon: Download,
      title: 'Install app',
      action: { label: 'Install', onPick: picked },
      onDismiss: (r) => heard.push(r)
    })
    pickBandAction(a)
    expect(picked).toHaveBeenCalledTimes(1)
    expect(heard).toEqual(['action'])
    expect(shownBand()).toBeNull()
    const asked = vi.fn()
    const db = showBand({
      key: 'default-browser',
      form: 'state',
      icon: Globe,
      title: 'Make Zenium your default browser',
      action: { label: 'Set as default', onPick: asked, holds: true },
      onDismiss: (r) => heard.push(r)
    })
    pickBandAction(db)
    expect(asked).toHaveBeenCalledTimes(1)
    expect(shownBand()?.id).toBe(db)
    expect(heard).toEqual(['action'])
  })

  it('every dismissal names its reason once, and a band gone is gone: a second dismissal is nothing', () => {
    const heard: BandDismissReason[] = []
    // `'back'` is Android's Back button putting the band away: a put-away like a swipe, which
    // the model carries to the tenant as any other reason (the desktop never emits it).
    for (const reason of ['close', 'swipe', 'escape', 'back', 'program'] as const) {
      const a = install('t1', (r) => heard.push(r))
      dismissBand(a, reason)
      dismissBand(a, reason)
      expect(shownBand()).toBeNull()
    }
    expect(heard).toEqual(['close', 'swipe', 'escape', 'back', 'program'])
    // The store's setter is a no-op on an unknown id: no listener hears anything.
    const listener = vi.fn()
    const off = bandStore.subscribe(listener)
    dismissBand(99_999)
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('an offer given its own clock keeps it; an offer given none stands like a state', () => {
    const quick = showBand({
      key: 'quick',
      form: 'offer',
      tabId: 't1',
      icon: Download,
      title: 'Install app',
      duration: 3000
    })
    expect(bandClockLeft(quick)).toBe(3000)
    vi.advanceTimersByTime(3000)
    expect(shownBand()).toBeNull()
    const standing = showBand({
      key: 'standing',
      form: 'offer',
      tabId: 't1',
      icon: Download,
      title: 'Install app',
      duration: null
    })
    vi.advanceTimersByTime(BAND_CLOCK_MS * 3)
    expect(shownBand()?.id).toBe(standing)
  })
})
