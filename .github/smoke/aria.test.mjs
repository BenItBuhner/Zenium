import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ARIA_STATES,
  AXE_GATE,
  ariaBaselineName,
  ariaDiff,
  axeVerdict,
  flattenAxe,
  formatAriaDiff,
  formatAxeViolation,
  normalizeAriaSnapshot,
  parseAxeAllowlist
} from './aria.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ariaDir = join(here, 'aria')

describe('normalizeAriaSnapshot', () => {
  it('ends in one newline, on LF, with no trailing blank lines', () => {
    expect(normalizeAriaSnapshot('- button "A"\r\n- button "B"\r\n\r\n')).toBe(
      '- button "A"\n- button "B"\n'
    )
    expect(normalizeAriaSnapshot('')).toBe('\n')
    expect(normalizeAriaSnapshot(undefined)).toBe('\n')
  })

  it('takes the fixture origin out wherever it shows: the host and port become "fixture"', () => {
    const origin = 'http://127.0.0.1:41233'
    const text =
      '- group "Address":\n  - button "127.0.0.1:41233/first.html"\n' +
      '- option "Smoke fixture: first page http://127.0.0.1:41233/first.html"\n'
    expect(normalizeAriaSnapshot(text, { origin })).toBe(
      '- group "Address":\n  - button "fixture/first.html"\n' +
        '- option "Smoke fixture: first page http://fixture/first.html"\n'
    )
  })

  it('leaves a snapshot alone with no origin to take out', () => {
    expect(normalizeAriaSnapshot('- button "127.0.0.1:1/x"\n')).toBe('- button "127.0.0.1:1/x"\n')
  })
})

describe('ariaDiff', () => {
  const expected = ['- a', '- b', '- c', '- d', '- e', '- f', '- g', ''].join('\n')

  it('is null for equal snapshots', () => {
    expect(ariaDiff(expected, expected)).toBeNull()
  })

  it('names the first differing line with context from each side', () => {
    const actual = expected.replace('- e', '- E')
    const diff = ariaDiff(expected, actual, 2)
    expect(diff).toEqual({
      line: 5,
      expected: ['- c', '- d', '- e', '- f', '- g'],
      actual: ['- c', '- d', '- E', '- f', '- g'],
      expectedLines: 8,
      actualLines: 8
    })
    const text = formatAriaDiff('resting-window', diff)
    expect(text).toContain('"resting-window" differs from its baseline at line 5')
    expect(text).toContain('    - E')
  })

  it('sees a line missing at the end', () => {
    const diff = ariaDiff(expected, expected.replace('- g\n', ''))
    expect(diff?.line).toBe(7)
    expect(diff?.actual).toEqual(['- d', '- e', '- f', ''])
  })
})

const results = {
  violations: [
    {
      id: 'button-name',
      impact: 'critical',
      help: 'Buttons must have discernible text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/button-name',
      nodes: [
        {
          target: ['.zen-toolbar-button:nth-child(2)'],
          html: '<button class="zen-toolbar-button"></button>',
          failureSummary: 'Fix any of the following:\n  Element does not have inner text'
        },
        { target: [['iframe', '#inner button']], html: '<button></button>', failureSummary: '' }
      ]
    },
    {
      id: 'landmark-complementary-is-top-level',
      impact: 'moderate',
      help: 'Aside should not be contained in another landmark',
      nodes: [{ target: ['main > aside'], html: '<aside>', failureSummary: 'x' }]
    },
    {
      id: 'aria-hidden-focus',
      impact: 'serious',
      help: 'ARIA hidden element must not be focusable or contain focusable elements',
      nodes: [{ target: ['[data-ext-panel] button'], html: '<button>', failureSummary: 'y' }]
    }
  ]
}

describe('flattenAxe', () => {
  it('is one record per node with the rule, impact, target and a short summary', () => {
    const flat = flattenAxe(results)
    expect(flat.map((v) => `${v.impact} ${v.rule} ${v.target}`)).toEqual([
      'critical button-name .zen-toolbar-button:nth-child(2)',
      'critical button-name iframe >> #inner button',
      'moderate landmark-complementary-is-top-level main > aside',
      'serious aria-hidden-focus [data-ext-panel] button'
    ])
    expect(flat[0].summary).toBe('Fix any of the following: Element does not have inner text')
    expect(flat[0].helpUrl).toContain('button-name')
  })

  it('reads an empty or missing result as no violations', () => {
    expect(flattenAxe({})).toEqual([])
    expect(flattenAxe(undefined)).toEqual([])
  })
})

describe('axeVerdict', () => {
  const flat = flattenAxe(results)

  it('fails the serious and critical violations and reports the milder ones', () => {
    expect(AXE_GATE).toEqual(['serious', 'critical'])
    const verdict = axeVerdict('resting-window', flat)
    expect(verdict.failing.map((v) => v.rule)).toEqual([
      'button-name',
      'button-name',
      'aria-hidden-focus'
    ])
    expect(verdict.tolerated).toEqual([])
    expect(verdict.other.map((v) => v.rule)).toEqual(['landmark-complementary-is-top-level'])
  })

  it('tolerates a gated violation an allowlist entry names, by rule and target, in its states', () => {
    const allow = parseAxeAllowlist({
      entries: [
        {
          id: 'EXT-1',
          rule: 'aria-hidden-focus',
          target: '^\\[data-ext-panel\\]',
          states: ['resting-window'],
          note: 'the extensions program’s panel'
        }
      ]
    })
    const atRest = axeVerdict('resting-window', flat, allow)
    expect(atRest.tolerated.map((v) => `${v.rule}:${v.knownAs}`)).toEqual([
      'aria-hidden-focus:EXT-1'
    ])
    expect(atRest.failing.map((v) => v.rule)).toEqual(['button-name', 'button-name'])
    // Another state: the entry does not apply.
    const menu = axeVerdict('app-menu', flat, allow)
    expect(menu.tolerated).toEqual([])
    expect(menu.failing).toHaveLength(3)
    expect(formatAxeViolation(atRest.tolerated[0])).toBe(
      'serious aria-hidden-focus at [data-ext-panel] button (known: EXT-1): ARIA hidden element must not be focusable or contain focusable elements'
    )
  })
})

describe('parseAxeAllowlist', () => {
  it('requires an entries array, string ids, a rule and a compiling target regex', () => {
    expect(() => parseAxeAllowlist(null)).toThrow(/entries/)
    expect(() => parseAxeAllowlist({ entries: [{}] })).toThrow(/string id/)
    expect(() => parseAxeAllowlist({ entries: [{ id: 'a' }] })).toThrow(/rule/)
    expect(() => parseAxeAllowlist({ entries: [{ id: 'a', rule: 'r' }] })).toThrow(/target/)
    expect(() => parseAxeAllowlist({ entries: [{ id: 'a', rule: 'r', target: '(' }] })).toThrow(
      /does not compile/
    )
    expect(() =>
      parseAxeAllowlist({
        entries: [
          { id: 'a', rule: 'r', target: 'x' },
          { id: 'a', rule: 'r', target: 'y' }
        ]
      })
    ).toThrow(/duplicates/)
    expect(() =>
      parseAxeAllowlist({ entries: [{ id: 'a', rule: 'r', target: 'x', states: ['nowhere'] }] })
    ).toThrow(/states/)
  })

  it('accepts an empty allowlist', () => {
    expect(parseAxeAllowlist({ entries: [] })).toEqual([])
  })
})

describe('the checked-in baselines (.github/smoke/aria)', () => {
  it('has one baseline per state, normalised, and each names the roles its state is about', () => {
    expect(ARIA_STATES).toEqual([
      'resting-window',
      'app-menu',
      'urlbar',
      'hosted-dialog',
      'web-capture'
    ])
    const files = readdirSync(ariaDir)
      .filter((f) => f.endsWith('.aria.yaml'))
      .sort()
    expect(files).toEqual(ARIA_STATES.map(ariaBaselineName).sort())
    for (const state of ARIA_STATES) {
      const text = readFileSync(join(ariaDir, ariaBaselineName(state)), 'utf8')
      expect(text, state).toBe(normalizeAriaSnapshot(text))
      // No ephemeral port slipped in: the fixture's host is the placeholder.
      expect(text, state).not.toMatch(/127\.0\.0\.1:\d+/)
    }
    const resting = readFileSync(join(ariaDir, ariaBaselineName('resting-window')), 'utf8')
    expect(resting).toMatch(/^- complementary "Sidebar":/m)
    expect(resting).toMatch(/- toolbar "Toolbar":/)
    expect(resting).toMatch(/- navigation "Tabs":/)
    // The walkthrough's window is a local one: no Essentials, one tablist of the space's rows.
    expect(resting).not.toMatch(/Essentials/)
    expect(resting.match(/- tablist "[^"]+":/g)).toHaveLength(1)
    // A tab's name holds a colon, so the snapshot quotes the line; its title and close button
    // are its children (Chromium exposes a tab's children unless it holds one text alone).
    expect(resting).toMatch(/- 'tab "Smoke fixture: first page" \[selected\]':/)
    expect(resting).toMatch(
      /- 'tab "Smoke fixture: second page"':\n\s+- text: "Smoke fixture: second page"\n\s+- button "Close tab"/
    )
    expect(resting).not.toMatch(/\[selected\][\s\S]*\[selected\]/)
    expect(resting).toMatch(/- button "Menu \(Alt\+F\)"/)
    expect(resting).toMatch(/^- main/m)
    expect(resting).toMatch(/- group "Address":/)
    const menu = readFileSync(join(ariaDir, ariaBaselineName('app-menu')), 'utf8')
    expect(menu).toMatch(/^- menu "Zenium":/)
    expect(menu).toMatch(/- menuitem "Settings"/)
    expect(menu).toMatch(/- separator/)
    const urlbar = readFileSync(join(ariaDir, ariaBaselineName('urlbar')), 'utf8')
    expect(urlbar).toMatch(/- combobox "Search or enter address"/)
    expect(urlbar).toMatch(/- listbox:/)
    expect(urlbar).toMatch(/- option "/)
    const dialog = readFileSync(join(ariaDir, ariaBaselineName('hosted-dialog')), 'utf8')
    expect(dialog).toMatch(/^- dialog "Add search engine":/)
    expect(dialog).toMatch(/- heading "Add search engine"/)
    expect(dialog).toMatch(/- textbox "Name"/)
    expect(dialog).toMatch(/- button "Add"/)
    // The Web capture overlay: the modal dialog with its toolbar – the hint that the page's
    // geometry is known, the two whole-page captures and Cancel (capture-01, capture-16).
    const capture = readFileSync(join(ariaDir, ariaBaselineName('web-capture')), 'utf8')
    expect(capture).toMatch(/^- dialog "Web capture"/)
    expect(capture).toMatch(/- toolbar "Capture":/)
    expect(capture).toMatch(/Drag to select an area/)
    expect(capture).toMatch(/- button "Visible area"/)
    expect(capture).toMatch(/- button "Full page"/)
    expect(capture).toMatch(/- button "Cancel capture"/)
  })

  it('has an axe allowlist that parses, every entry on a surface the chrome does not own', () => {
    const file = join(ariaDir, 'axe-known.json')
    expect(existsSync(file)).toBe(true)
    const entries = parseAxeAllowlist(JSON.parse(readFileSync(file, 'utf8')))
    for (const entry of entries) {
      expect(entry.note, entry.id).toMatch(/services|extension/i)
    }
  })
})
