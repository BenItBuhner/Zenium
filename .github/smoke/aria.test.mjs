import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ARIA_FACTS_HEADER,
  ARIA_STATES,
  AXE_GATE,
  ariaBaselineName,
  ariaDiff,
  axeVerdict,
  flattenAxe,
  formatAriaDiff,
  formatAriaFacts,
  formatAxeViolation,
  normalizeAriaSnapshot,
  parseAxeAllowlist,
  withAriaFacts
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

describe('formatAriaFacts', () => {
  it('writes one line per element in the snapshot’s shape: role, name, states and attributes, description', () => {
    expect(
      formatAriaFacts([
        {
          role: 'button',
          name: 'Back (Alt+←)',
          flags: ['focused'],
          attrs: { describedby: 'zen-tooltip', side: 'below' }
        },
        {
          role: 'tab',
          name: 'Smoke fixture: first page',
          flags: ['selected'],
          attrs: { posinset: 2, setsize: 2 },
          description: 'muted'
        },
        { role: 'complementary', name: 'Sidebar', flags: ['inert'] },
        { role: 'status', attrs: { live: 'polite', atomic: true }, description: '1 of 2 matches' }
      ])
    ).toBe(
      [
        '- button "Back (Alt+←)" [focused describedby=zen-tooltip side=below]',
        '- tab "Smoke fixture: first page" [selected posinset=2 setsize=2]: muted',
        '- complementary "Sidebar" [inert]',
        '- status [live=polite atomic]: 1 of 2 matches'
      ].join('\n')
    )
  })

  it('leaves out what is not there: no brackets without states, no colon without a description, false and empty attributes dropped', () => {
    expect(formatAriaFacts([{ role: 'frame' }])).toBe('- frame')
    expect(
      formatAriaFacts([
        { role: 'tab', name: 'a "quoted" name', attrs: { posinset: 0, hidden: false, x: '' } }
      ])
    ).toBe('- tab "a \\"quoted\\" name" [posinset=0]')
    expect(formatAriaFacts([])).toBe('')
    expect(formatAriaFacts(undefined)).toBe('')
  })
})

describe('withAriaFacts', () => {
  it('writes the facts under the snapshot after a blank line and the header, ending in one newline', () => {
    const snapshot = normalizeAriaSnapshot('- tooltip: Back (Alt+←)\n')
    expect(
      withAriaFacts(snapshot, [{ role: 'button', name: 'Back (Alt+←)', flags: ['focused'] }])
    ).toBe(`- tooltip: Back (Alt+←)\n\n${ARIA_FACTS_HEADER}\n- button "Back (Alt+←)" [focused]\n`)
  })

  it('is the snapshot alone for a state without facts', () => {
    const snapshot = normalizeAriaSnapshot('- button "A"\n')
    expect(withAriaFacts(snapshot, [])).toBe(snapshot)
    expect(withAriaFacts(snapshot, undefined)).toBe(snapshot)
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
      'dialog-cover',
      'tooltip-focus',
      'tab-row',
      'find-status'
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
  })

  it('the pass-2 baselines carry the facts the snapshot leaves out, each about its own claim', () => {
    const read = (state) => readFileSync(join(ariaDir, ariaBaselineName(state)), 'utf8')
    const factsOf = (text) => {
      const at = text.indexOf(`\n${ARIA_FACTS_HEADER}\n`)
      expect(at, 'a facts block').toBeGreaterThan(0)
      return text.slice(at + ARIA_FACTS_HEADER.length + 2)
    }
    // The cover (a11y-32): the same dialog as hosted-dialog, and under it the sidebar, the
    // toolbar's Back button and the content frame inert, the dialog itself live with the
    // keyboard on its first field – after an F6 that moved it nowhere.
    const cover = read('dialog-cover')
    expect(cover).toMatch(/^- dialog "Add search engine":/)
    const coverFacts = factsOf(cover)
    expect(coverFacts).toMatch(/^- complementary "Sidebar" \[inert\]$/m)
    expect(coverFacts).toMatch(/^- button "Back \([^)]+\)" \[inert\]$/m)
    expect(coverFacts).toMatch(/^- frame \[inert\]$/m)
    expect(coverFacts).toMatch(/^- dialog "Add search engine"(?! \[)[^\n]*$/m)
    expect(coverFacts).toMatch(/^- textbox "Name" \[focused\]$/m)
    // The tooltip on keyboard focus (a11y-26): the focused Back button described by the one
    // tooltip, which names the control with its shortcut and stands below it.
    const tip = read('tooltip-focus')
    expect(tip).toMatch(/^- tooltip "Back \([^)]+\)"$/m)
    const tipFacts = factsOf(tip)
    expect(tipFacts).toMatch(
      /^- button "Back \([^)]+\)" \[focused describedby=zen-tooltip\]: Back \([^)]+\)$/m
    )
    expect(tipFacts).toMatch(/^- tooltip "Back \([^)]+\)" \[side=below by=focus\]$/m)
    // The tab rows (a11y-31): each row's place in the two-row list and the muted row's state in
    // its description; the row's Unmute button pressed in the tree above.
    const rows = read('tab-row')
    expect(rows).toMatch(/^- tablist "[^"]+":/)
    expect(rows).toMatch(/- button "Unmute tab" \[pressed\]/)
    const rowFacts = factsOf(rows)
    expect(rowFacts).toMatch(/^- tab "Smoke fixture: second page" \[posinset=1 setsize=2\]$/m)
    expect(rowFacts).toMatch(
      /^- tab "Smoke fixture: first page" \[selected posinset=2 setsize=2\]: muted$/m
    )
    // The find bar's count (a11y-35): a polite, atomic status region whose spoken text is the
    // count in words, the figures the eye reads hidden from it.
    const find = read('find-status')
    expect(find).toMatch(/^- search "Find in page":/)
    expect(find).toMatch(/- status: 1 of 2 matches/)
    expect(find).not.toMatch(/1\/2/)
    expect(factsOf(find)).toMatch(/^- status "1 of 2 matches" \[live=polite atomic=true\]$/m)
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
