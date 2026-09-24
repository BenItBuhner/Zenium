// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  accessibleNameOf,
  auditNames,
  formatNameFindings,
  leadingTextOf,
  nameCarries,
  visiblePiecesOf,
  visibleTextOf
} from '../a11yNames'

/*
 * The name audit's rule (A11Y-10), on hand-made controls: the name a reader takes, the text a
 * user reads, what carries what, and the findings on a chrome that falls short – so the audits
 * over the real surfaces (`phone/__tests__/phoneNames.test.tsx`, the menu's) mean what they say.
 */

function html(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  document.body.appendChild(root)
  return root
}

describe('the name audit (A11Y-10)', () => {
  it('reads the visible text in pieces, aria-hidden parts left out, a repeated piece once', () => {
    const root = html(
      '<button><span aria-hidden="true">★</span><span>Tea - Wikipedia</span>' +
        '<span class="pic">Tea - Wikipedia</span><small>en.wikipedia.org</small></button>'
    )
    const button = root.querySelector('button')!
    expect(visiblePiecesOf(button)).toEqual(['Tea - Wikipedia', 'en.wikipedia.org'])
    expect(visibleTextOf(button)).toBe('Tea - Wikipedia en.wikipedia.org')
    expect(leadingTextOf(button)).toBe('Tea - Wikipedia')
  })

  it('takes the name as a reader does: aria-label, then aria-labelledby, then a field\u2019s label or placeholder, then the content', () => {
    const root = html(
      '<button aria-label="Tabs (6)">6</button>' +
        '<h2 id="t">Site information</h2><div role="button" aria-labelledby="t">x</div>' +
        '<input placeholder="Find in Settings">' +
        '<label for="q">Search</label><input id="q">' +
        '<a href="#">History</a>' +
        '<button title="Menu"><svg></svg></button>' +
        '<button><svg></svg></button>'
    )
    const [tabs, labelled, placeholder, search, link, titled, bare] = [
      ...root.querySelectorAll('button, [role=button], input, a')
    ]
    expect(accessibleNameOf(tabs)).toBe('Tabs (6)')
    expect(accessibleNameOf(labelled)).toBe('Site information')
    expect(accessibleNameOf(placeholder)).toBe('Find in Settings')
    expect(accessibleNameOf(search)).toBe('Search')
    expect(accessibleNameOf(link)).toBe('History')
    expect(accessibleNameOf(titled)).toBe('Menu')
    expect(accessibleNameOf(bare)).toBe('')
  })

  it('a name carries the visible text when the text is inside it, case aside', () => {
    expect(nameCarries('Tabs (6)', '6')).toBe(true)
    expect(nameCarries('Alpha, tab 1 of 6, current', 'Alpha')).toBe(true)
    expect(nameCarries('Address, example.com, Secure', 'example.com')).toBe(true)
    expect(nameCarries('reload', 'Reload')).toBe(true)
    expect(nameCarries('Reopen the tab', 'Undo')).toBe(false)
    expect(nameCarries('Menu', '')).toBe(true)
  })

  it('finds the controls that fall short – a glyph without a name, a name that is not the text shown – and passes the rest, aria-hidden ones left aside', () => {
    const root = html(
      '<button aria-label="Reload"><svg></svg></button>' +
        '<button aria-label="Tabs (6)">6</button>' +
        '<div role="button" aria-label="Research, tab group, 2 tabs"><span>Research</span><span>2</span></div>' +
        '<button aria-label="Reopen the tab">Undo</button>' +
        '<button class="zen-bar-x" data-bar-item="share"><svg></svg></button>' +
        '<div aria-hidden="true"><button><svg></svg></button></div>' +
        '<button disabled aria-label="Go forward">Forward</button>' +
        '<button disabled aria-label="Next page">Forward</button>'
    )
    const findings = auditNames(root)
    expect(findings.map((f) => f.issue)).toEqual(['mismatch', 'unnamed', 'mismatch'])
    expect(formatNameFindings(findings)).toBe(
      [
        "button: named 'Reopen the tab', shows 'Undo'",
        "button.zen-bar-x[data-bar-item=share]: no accessible name (shows '')",
        "button: named 'Next page', shows 'Forward'"
      ].join('\n')
    )
  })
})
