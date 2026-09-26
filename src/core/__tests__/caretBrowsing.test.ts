import { describe, expect, it, vi } from 'vitest'
import { CaretBrowsing } from '../caretBrowsing'
import type { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { TabView } from '../platform'

interface Harness {
  caret: CaretBrowsing
  settings: { caretBrowsing?: boolean; caretBrowsingConfirm?: boolean }
  views: FakeView[]
  ask: ReturnType<typeof vi.fn>
  commits: number
  win: ZenWindow
}

class FakeView {
  calls: boolean[] = []
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  setCaretBrowsingEnabled(enabled: boolean): void {
    this.calls.push(enabled)
  }
}

/** A host without the engine call has no `setCaretBrowsingEnabled` at all. */
class BareView {
  isDestroyed(): boolean {
    return false
  }
}

function harness(
  options: {
    supported?: boolean
    answer?: boolean
    settings?: Harness['settings']
    views?: number
    bare?: boolean
  } = {}
): Harness {
  const settings: Harness['settings'] = { ...(options.settings ?? {}) }
  const views = Array.from({ length: options.views ?? 2 }, () => new FakeView())
  const ask = vi.fn(async () => options.answer ?? true)
  const state = {
    capabilities: { caretBrowsing: options.supported ?? true },
    settings,
    commit: vi.fn()
  }
  const browser = {
    state,
    windowPrompts: { ask },
    tabs: {
      allViews: () =>
        (options.bare ? [new BareView()] : views).map(
          (v, i) => [`t${i}`, v as unknown as TabView] as [string, TabView]
        )
    }
  } as unknown as Browser
  const h: Harness = {
    caret: new CaretBrowsing(browser),
    settings,
    views,
    ask,
    win: { id: 'w1' } as unknown as ZenWindow,
    get commits() {
      return state.commit.mock.calls.length
    }
  }
  return h
}

describe('caret browsing (CT-34): F7 in Chrome and Edge', () => {
  it('asks once, then turns the caret on for every page and remembers it', async () => {
    const h = harness()
    expect(h.caret.enabled).toBe(false)
    await h.caret.toggle(h.win)
    expect(h.ask).toHaveBeenCalledWith(h.win, 'caret-browsing', 0)
    expect(h.settings.caretBrowsing).toBe(true)
    expect(h.caret.enabled).toBe(true)
    // One call per live view (the one IPC each), all true.
    for (const view of h.views) expect(view.calls).toEqual([true])
    expect(h.commits).toBe(1)
  })

  it('F7 again turns it off with no question', async () => {
    const h = harness({ settings: { caretBrowsing: true } })
    await h.caret.toggle(h.win)
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.settings.caretBrowsing).toBe(false)
    for (const view of h.views) expect(view.calls).toEqual([false])
  })

  it('a declined confirm changes nothing', async () => {
    const h = harness({ answer: false })
    await h.caret.toggle(h.win)
    expect(h.ask).toHaveBeenCalledTimes(1)
    expect(h.settings.caretBrowsing).toBeUndefined()
    for (const view of h.views) expect(view.calls).toEqual([])
    expect(h.commits).toBe(0)
  })

  it("the dialog's Don't ask again (caretBrowsingConfirm off) lets F7 turn it on at once", async () => {
    const h = harness({ settings: { caretBrowsingConfirm: false } })
    await h.caret.toggle(h.win)
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.settings.caretBrowsing).toBe(true)
    for (const view of h.views) expect(view.calls).toEqual([true])
  })

  it('a page that opens while it is on gets the caret at creation; off, it is left alone', () => {
    const on = harness({ settings: { caretBrowsing: true } })
    const fresh = new FakeView()
    on.caret.onViewCreated(fresh as unknown as TabView)
    expect(fresh.calls).toEqual([true])
    const off = harness()
    const other = new FakeView()
    off.caret.onViewCreated(other as unknown as TabView)
    expect(other.calls).toEqual([])
  })

  it('the Settings row (or a sync merge) reaches the pages through onSettingsChanged', () => {
    const h = harness()
    h.settings.caretBrowsing = true
    h.caret.onSettingsChanged()
    for (const view of h.views) expect(view.calls).toEqual([true])
    h.settings.caretBrowsing = false
    h.caret.onSettingsChanged()
    for (const view of h.views) expect(view.calls).toEqual([true, false])
  })

  it('a destroyed view is skipped', () => {
    const h = harness({ views: 2 })
    h.views[1]!.destroyed = true
    h.caret.set(true)
    expect(h.views[0]!.calls).toEqual([true])
    expect(h.views[1]!.calls).toEqual([])
  })

  it('a host without the engine call (Android) does nothing: no question, no setting', async () => {
    const h = harness({ supported: false })
    await h.caret.toggle(h.win)
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.settings.caretBrowsing).toBeUndefined()
    expect(h.caret.enabled).toBe(false)
    // Even a setting synced from the desktop reads as off where the engine cannot do it.
    h.settings.caretBrowsing = true
    expect(h.caret.enabled).toBe(false)
    h.caret.onSettingsChanged()
    for (const view of h.views) expect(view.calls).toEqual([])
  })

  it('a view without the method is tolerated', () => {
    const h = harness({ bare: true })
    expect(() => h.caret.set(true)).not.toThrow()
    expect(h.settings.caretBrowsing).toBe(true)
  })
})
