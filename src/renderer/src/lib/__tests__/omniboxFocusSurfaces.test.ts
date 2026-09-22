// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ cmd: vi.fn(async () => null), run: vi.fn() }))

import {
  bindOmniboxFocus,
  FOCUS_SLOT_LEFT_VAR,
  FOCUS_SLOT_RIGHT_VAR,
  FOCUS_SLOT_SCALE_VAR,
  FOCUS_VAR,
  focusOmnibox,
  omniboxFocusStore,
  omniboxFocusSurfaces
} from '../omniboxFocus'
import { closeUrlbar, uiStore } from '../ui'

/*
 * Where the focus motion's value goes (PERF-2's H3; the pattern of `--zen-recede`, #269, and
 * `--zen-bar-hide`, #270). `--zen-omnibox-focus` inherits – the field's backdrop is a `::before`,
 * and every reader is a descendant of the bar or of the omnibox's layer – so the size of a
 * frame's style recalculation is the subtree of whatever element carries the value: written on
 * the root, as #307's first head had it, every spring frame recalculated the whole chrome's
 * style (6 to 31 ms of `UpdateLayoutTree` against under half a millisecond of layout and paint,
 * the first-line review's trace). So the controller writes it on the elements its components
 * bind (`bindOmniboxFocus`: the bar in PhoneShell, the layer in Urlbar's PhoneSheet) and never
 * on the root; this pins that at every frame of a run, that a surface binding mid-flight (the
 * layer mounting under the tap, the bar mounting again for the way back) carries the value and
 * the slot at once, that the rest leaves nothing behind, and – over the stylesheets – that every
 * rule reading the value has its subject under one of the two bound elements.
 */

const ASSETS = resolve(__dirname, '../../assets')
const SURFACE_ROOTS = ['.zen-phone-bar', '.zen-omnibox-layer']
/** The classes on the two bound elements and their descendants that the rules name. */
const UNDER_A_SURFACE =
  /\.zen-phone-bar\b|\.zen-phone-pill\b|\.zen-omnibox-sheet\b|\.zen-omnibox-field\b/

const root = (): HTMLElement => document.documentElement
const read = (el: HTMLElement, name: string): string => el.style.getPropertyValue(name)
const VARS = [FOCUS_VAR, FOCUS_SLOT_LEFT_VAR, FOCUS_SLOT_RIGHT_VAR, FOCUS_SLOT_SCALE_VAR]

function box(el: HTMLElement, x: number, width: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: x,
      top: 700,
      width,
      height: 44,
      x,
      y: 700,
      right: x + width,
      bottom: 744
    })
  })
}

/** A phone bar as the shell mounts it: the band 344 wide, one 44 button and a 4 gap either side of the pill. */
function mountBar(): { bar: HTMLElement; release: () => void } {
  const bar = document.createElement('nav')
  bar.className = 'zen-phone-bar'
  const row = document.createElement('div')
  row.className = 'zen-phone-bar-row'
  const pill = document.createElement('div')
  pill.className = 'zen-phone-pill'
  row.appendChild(pill)
  bar.appendChild(row)
  document.body.appendChild(bar)
  box(row, 8, 344)
  box(pill, 56, 248)
  const unbind = bindOmniboxFocus(bar)
  return {
    bar,
    release: () => {
      unbind()
      bar.remove()
    }
  }
}

let frames: Array<(now: number) => void> = []
let now = 1000
const tick = (): void => {
  now += 16
  for (const cb of frames.splice(0)) cb(now)
}
/** Runs the spring to its rest: the phase leaves `opening` / `closing`. */
function settle(): number {
  let n = 0
  const moving = (): boolean => ['opening', 'closing'].includes(omniboxFocusStore.get().phase)
  while (moving() && n < 200) {
    tick()
    n++
  }
  expect(moving(), 'the spring came to rest').toBe(false)
  return n
}
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

function expectRootClean(): void {
  for (const name of VARS) expect(read(root(), name), `${name} on the root`).toBe('')
}

describe('where the value goes: the bound surfaces, never the root', () => {
  const releases: Array<() => void> = []

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

  afterEach(async () => {
    // Whatever a test left up comes down: the omnibox closed on a dismissal runs the field home.
    if (uiStore.get().urlbar.open) {
      closeUrlbar({ reason: 'dismiss' })
      settle()
      await flush()
    }
    for (const r of releases.splice(0)) r()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    expect(omniboxFocusSurfaces()).toEqual([])
  })

  it('a tap runs the spring on the bar and the layer alike, the root carrying nothing at any frame', async () => {
    const { bar, release } = mountBar()
    releases.push(release)
    focusOmnibox(null)
    expect(omniboxFocusStore.get().phase).toBe('opening')
    // The slot the pill left, on the bar at the tap; the value at the pill's pose.
    expect(read(bar, FOCUS_SLOT_LEFT_VAR)).toBe('48.00px')
    expect(read(bar, FOCUS_SLOT_RIGHT_VAR)).toBe('48.00px')
    expect(read(bar, FOCUS_SLOT_SCALE_VAR)).toBe((248 / 344).toFixed(4))
    expect(read(bar, FOCUS_VAR)).toBe('0.0000')
    expectRootClean()
    await flush()
    expect(uiStore.get().urlbar.open).toBe(true)
    // The omnibox's layer mounts under the tap and binds: the value and the slot at once, so
    // its first frame is the spring's and not the fallback's.
    const layer = document.createElement('div')
    layer.className = 'zen-omnibox-layer'
    document.body.appendChild(layer)
    const unbindLayer = bindOmniboxFocus(layer)
    releases.push(() => {
      unbindLayer()
      layer.remove()
    })
    expect(read(layer, FOCUS_VAR)).toBe(read(bar, FOCUS_VAR))
    expect(read(layer, FOCUS_SLOT_LEFT_VAR)).toBe('48.00px')
    expect(read(layer, FOCUS_SLOT_SCALE_VAR)).toBe((248 / 344).toFixed(4))
    let last = 0
    let moved = 0
    while (omniboxFocusStore.get().phase === 'opening' && moved < 200) {
      tick()
      moved++
      const value = Number(read(bar, FOCUS_VAR))
      // One value on both; the root untouched; the spring monotonic toward the omnibox.
      expect(read(layer, FOCUS_VAR)).toBe(read(bar, FOCUS_VAR))
      expect(value).toBeGreaterThanOrEqual(last)
      expectRootClean()
      last = value
    }
    expect(moved).toBeGreaterThan(3)
    expect(omniboxFocusStore.get().phase).toBe('open')
    expect(read(layer, FOCUS_VAR)).toBe('1.0000')
    expect(read(bar, FOCUS_VAR)).toBe('1.0000')
    expectRootClean()
  })

  it('a dismissal runs the value back on a bar bound again for the way, and the rest leaves every surface bare', async () => {
    const { bar, release } = mountBar()
    releases.push(release)
    focusOmnibox(null)
    await flush()
    settle()
    expect(omniboxFocusStore.get().phase).toBe('open')
    // The bar is unmounted under the open omnibox and mounted again as the close begins.
    release()
    releases.pop()
    expect(read(bar, FOCUS_VAR)).toBe('')
    closeUrlbar({ reason: 'dismiss' })
    expect(omniboxFocusStore.get().phase).toBe('closing')
    // The urlbar stays open under the held close until the field has landed in the pill.
    expect(uiStore.get().urlbar.open).toBe(true)
    const again = mountBar()
    releases.push(again.release)
    expect(read(again.bar, FOCUS_VAR)).toBe('1.0000')
    expect(read(again.bar, FOCUS_SLOT_LEFT_VAR)).toBe('48.00px')
    let last = 1
    while (omniboxFocusStore.get().phase === 'closing') {
      tick()
      const value = Number(read(again.bar, FOCUS_VAR))
      expect(value).toBeLessThanOrEqual(last)
      expectRootClean()
      last = value
    }
    expect(omniboxFocusStore.get().phase).toBe('rest')
    expect(uiStore.get().urlbar.open).toBe(false)
    for (const name of VARS) expect(read(again.bar, name)).toBe('')
    expectRootClean()
    // A surface binding at rest carries nothing.
    const idle = document.createElement('div')
    const unbind = bindOmniboxFocus(idle)
    for (const name of VARS) expect(read(idle, name)).toBe('')
    unbind()
  })

  it('a release mid-flight clears the surface and stops writing to it', async () => {
    const { bar, release } = mountBar()
    releases.push(release)
    focusOmnibox(null)
    await flush()
    tick()
    tick()
    expect(Number(read(bar, FOCUS_VAR))).toBeGreaterThan(0)
    release()
    releases.pop()
    for (const name of VARS) expect(read(bar, name)).toBe('')
    tick()
    expect(read(bar, FOCUS_VAR)).toBe('')
    expect(omniboxFocusSurfaces()).toEqual([])
  })
})

describe('the readers (the stylesheets)', () => {
  const sheets = readdirSync(ASSETS)
    .filter((n) => n.endsWith('.css'))
    .sort()
    .map((n) => ({ name: n, css: readFileSync(join(ASSETS, n), 'utf8') }))
  const READ = /var\(--zen-omnibox-(?:focus|slot-[a-z]+)\s*[,)]/

  it('the value is registered as inheriting, by design, and the registration is the property’s only one', () => {
    const main = sheets.find((s) => s.name === 'main.css')!.css.replace(/\s+/g, ' ')
    expect(main).toContain(
      "@property --zen-omnibox-focus { syntax: '<number>'; inherits: true; initial-value: 0; }"
    )
    expect(main.match(/@property --zen-omnibox-focus/g)).toHaveLength(1)
  })

  it('every rule reading the value or the slot has its subject under the bar or the omnibox’s layer', () => {
    const readers: Array<{ sheet: string; selector: string }> = []
    for (const { name, css } of sheets) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, selectorList, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!READ.test(body)) continue
        for (const raw of selectorList.split(',')) {
          const selector = raw.replace(/\s+/g, ' ').trim()
          if (selector) readers.push({ sheet: name, selector })
        }
      }
    }
    // The rides exist, and each is under one of the two.
    expect(readers.length).toBeGreaterThan(10)
    for (const { sheet, selector } of readers) {
      expect(selector, `${sheet}: ${selector}`).toMatch(UNDER_A_SURFACE)
      expect(selector, `${sheet}: ${selector} reads on the root`).not.toMatch(
        /^:root(\[[^\]]*\])*$/
      )
    }
  })

  it('the controller never writes to the root’s style', () => {
    const source = readFileSync(resolve(__dirname, '../omniboxFocus.ts'), 'utf8')
    expect(source).not.toMatch(/documentElement\.style/)
    for (const s of SURFACE_ROOTS) expect(source).toContain(s)
  })
})
