// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KEYBOARD_FOCUS_ATTR } from '../panes'

/**
 * The pane chord's landing rings as a Tab's (design language v2 §1 as amended with #400; a11y-09).
 *
 * A chord (F6, Shift+F6, Shift+Alt+T, Shift+Alt+B) is consumed in the main process, so the
 * chrome document never sees a key and Chromium's `:focus-visible` heuristic reads the focus
 * lib/panes.ts moves as the mouse's: no ring. The landing carries `data-keyboard-focus` instead,
 * and every ring form in main.css draws for `[data-keyboard-focus]:focus` as for
 * `:focus-visible`, in the same rule. This test computes both landings on the same controls from
 * the rules as main.css writes them: the Tab landing with `:focus-visible` matching and no mark;
 * the chord landing with the mark and `:focus-visible` made to say no – the heuristic's answer –
 * by rewriting the pseudo-class to an attribute nothing carries (`[data-heuristic-no]`, the same
 * specificity class, so the cascade between the forms is the one the browser resolves). happy-dom
 * drops `@layer` blocks, so the base floor is injected as its inner rules, unlayered; the
 * component rules under test are unlayered in main.css as well, or sit in a media block whose
 * condition the test does not need, so the cascade order they meet here is the stylesheet's.
 */
const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule after `from`, braces included. */
function rule(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at) + 1)
}

/** The base-layer floor's inner rules (`*` at rest, the ring for both triggers), unwrapped. */
function floor(): string {
  const chapter = css.indexOf(" * The chrome's focus ring (v2 §1, a11y-10)")
  expect(chapter).toBeGreaterThan(0)
  const open = css.indexOf('@layer base {', chapter)
  return css.slice(open + '@layer base {'.length, css.indexOf('\n}', open))
}

const RULES = [
  floor(),
  // The shared `zen-v2-` ring.
  rule(
    "[class^='zen-v2-']:focus-visible,\n[class*=' zen-v2-']:focus-visible,\n:root[data-pointer='coarse'] [class^='zen-v2-']:focus-visible,\n:root[data-pointer='coarse'] [class*=' zen-v2-']:focus-visible,\n[class^='zen-v2-'][data-keyboard-focus]:focus,\n[class*=' zen-v2-'][data-keyboard-focus]:focus,\n:root[data-pointer='coarse'] [class^='zen-v2-'][data-keyboard-focus]:focus,\n:root[data-pointer='coarse'] [class*=' zen-v2-'][data-keyboard-focus]:focus"
  ),
  // A dialog root that holds the focus by design: no ring, for either trigger.
  rule(
    ":root [role='dialog'][tabindex='-1']:focus-visible,\n:root [role='alertdialog'][tabindex='-1']:focus-visible,\n:root [role='dialog'][tabindex='-1'][data-keyboard-focus]:focus,\n:root [role='alertdialog'][tabindex='-1'][data-keyboard-focus]:focus"
  ),
  // The URL field: the pill rings whole for the keyboard on its address button; the button, none.
  rule(
    '.zen-pill:has(> button:focus-visible),\n.zen-pill:has(> button[data-keyboard-focus]:focus)'
  ),
  rule('.zen-pill > button:focus-visible,\n.zen-pill > button[data-keyboard-focus]:focus'),
  // The bookmarks bar's chip: the ring inside, where the strip would clip it.
  rule('.zen-bm-chip:focus-visible,\n  .zen-bm-chip[data-keyboard-focus]:focus')
  // The toolbar glyph's full ink under the keyboard (`.zen-toolbar-button:is(… :focus-visible,
  // [data-keyboard-focus]:focus …) > svg`) is pinned statically in focusRing.test.ts: happy-dom
  // (20.x) does not match `:focus-visible` inside `:is()` when it computes a style.
].join('\n')

/** The tokens the rules read, resolved so a computed value is a value. */
const TOKENS = ':root { --v2-ring: rgb(10, 20, 30); --v2-ring-offset: 3px; }'

/** The heuristic's no: `:focus-visible` rewritten to an attribute nothing in the tree carries. */
const HEURISTIC_NO = RULES.replace(/:focus-visible/g, '[data-heuristic-no]')

type Ring = Record<'style' | 'width' | 'color' | 'offset', string>

function ring(el: Element): Ring {
  const s = getComputedStyle(el)
  return {
    style: s.getPropertyValue('outline-style'),
    width: s.getPropertyValue('outline-width'),
    color: s.getPropertyValue('outline-color'),
    offset: s.getPropertyValue('outline-offset')
  }
}

/** The landing controls of the panes (lib/panes.ts `paneTarget`, `paneFirstControl`). */
function chrome(): {
  tab: HTMLElement
  address: HTMLElement
  pill: HTMLElement
  chip: HTMLElement
  v2: HTMLElement
  dialog: HTMLElement
} {
  document.body.innerHTML = `
    <aside data-pane="tabs">
      <div class="zen-tab" role="tab" tabindex="0" data-tab-id="t1" data-active="true">Tab</div>
    </aside>
    <header data-pane="toolbar">
      <div class="zen-pill" role="group" aria-label="Address"><button>example.com</button></div>
      <button class="zen-v2-icon-button">Menu</button>
    </header>
    <div data-pane="bookmarks"><div class="zen-bm-chip" role="button" tabindex="0">Chip</div></div>
    <div role="dialog" tabindex="-1">Dialog</div>`
  const q = (selector: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) throw new Error(selector)
    return el
  }
  return {
    tab: q('.zen-tab'),
    address: q('.zen-pill > button'),
    pill: q('.zen-pill'),
    chip: q('.zen-bm-chip'),
    v2: q('.zen-v2-icon-button'),
    dialog: q("[role='dialog']")
  }
}

function sheet(text: string): void {
  const style = document.createElement('style')
  style.textContent = `${TOKENS}\n${text}`
  document.head.appendChild(style)
}

/** A Tab landing: the browser's own move, `:focus-visible` saying yes, no mark. */
function tabLanding(el: HTMLElement): void {
  el.focus()
}

/** A chord landing: lib/panes.ts's move – the mark set before the focus lands (`focusPane`). */
function chordLanding(el: HTMLElement): void {
  el.setAttribute(KEYBOARD_FOCUS_ATTR, '')
  el.focus()
}

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('the pane chord’s focus ring (§1 as amended, a11y-09)', () => {
  it('is the Tab landing’s ring on every landing control: the same style, width, colour and offset, from the rules as main.css writes them', () => {
    sheet(RULES)
    const tab = chrome()
    const byTab = {
      tab: (tabLanding(tab.tab), ring(tab.tab)),
      v2: (tabLanding(tab.v2), ring(tab.v2)),
      chip: (tabLanding(tab.chip), ring(tab.chip)),
      pill: (tabLanding(tab.address), ring(tab.pill)),
      address: ring(tab.address),
      dialog: (tabLanding(tab.dialog), ring(tab.dialog))
    }
    // The Tab landing draws the ring where §1 says: 2 px solid in the ring token – inset 2 on the
    // tab row (the floor), the chip and the URL field's pill; at the v2 offset on a v2 control;
    // none on the address button under its pill and on a dialog root.
    const accent = { style: 'solid', width: '2px', color: 'rgb(10, 20, 30)' }
    expect(byTab.tab).toEqual({ ...accent, offset: '-2px' })
    expect(byTab.chip).toEqual({ ...accent, offset: '-2px' })
    expect(byTab.pill).toEqual({ ...accent, offset: '-2px' })
    expect(byTab.v2).toEqual({ ...accent, offset: '3px' })
    expect(byTab.address.style).toBe('none')
    expect(byTab.dialog.style).toBe('none')

    document.head.innerHTML = ''
    sheet(HEURISTIC_NO)
    const chord = chrome()
    const byChord = {
      tab: (chordLanding(chord.tab), ring(chord.tab)),
      v2: (chordLanding(chord.v2), ring(chord.v2)),
      chip: (chordLanding(chord.chip), ring(chord.chip)),
      pill: (chordLanding(chord.address), ring(chord.pill)),
      address: ring(chord.address),
      dialog: (chordLanding(chord.dialog), ring(chord.dialog))
    }
    expect(byChord).toEqual(byTab)
  })

  it('is nothing without the mark: the heuristic’s no alone – a focus moved by script after the mouse – leaves the at-rest outline (the floor’s colour, width and offset, no style), so the mark is what the chord adds', () => {
    sheet(HEURISTIC_NO)
    const c = chrome()
    for (const [el, ringed] of [
      [c.tab, c.tab],
      [c.v2, c.v2],
      [c.chip, c.chip],
      [c.address, c.pill]
    ] as const) {
      const atRest = ring(ringed)
      expect(atRest.style, ringed.className).not.toBe('solid')
      el.focus()
      expect(ring(ringed), ringed.className).toEqual(atRest)
    }
  })

  it('goes with the mark: the control blurred, or the mark cleared as the next pointer press clears it (lib/panes.ts), the ring is gone', () => {
    sheet(HEURISTIC_NO)
    const c = chrome()
    const atRest = ring(c.tab)
    chordLanding(c.tab)
    expect(ring(c.tab).style).toBe('solid')
    c.tab.removeAttribute(KEYBOARD_FOCUS_ATTR)
    expect(ring(c.tab)).toEqual(atRest)
    chordLanding(c.tab)
    expect(ring(c.tab).style).toBe('solid')
    expect(c.tab.matches(`[${KEYBOARD_FOCUS_ATTR}]:focus`)).toBe(true)
    c.tab.blur()
    // The twin is `[data-keyboard-focus]:focus`, so the focus leaving ends its match even where
    // the mark has not been dropped yet. (Read as a match: happy-dom keeps an element's computed
    // style cached across its own blur, where a browser restyles.)
    expect(c.tab.matches(`[${KEYBOARD_FOCUS_ATTR}]:focus`)).toBe(false)
    expect(c.tab.matches(`[${KEYBOARD_FOCUS_ATTR}]`)).toBe(true)
  })
})
