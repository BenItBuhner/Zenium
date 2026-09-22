// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  PhoneEmptyNote,
  PhoneGroupHeading,
  PhoneIconButton,
  PhoneListRow,
  PhoneSelectionHeader
} from '../PhoneList'

/*
 * The phone history and bookmarks rows on the shared row primitive (design language v2 draft
 * 9.34): every row is the `.zen-v2-row` with the one `.zen-phone-row` modifier, a picked row
 * takes the `--v2-selected` fill with the accent-filled checkbox (9.6), a row action is the
 * shared `.zen-v2-icon-button` beside the accessible row, and what is not a target – a group's
 * heading, an empty note – is not a row at all, so no row of the panels is `data-static`.
 */

/** The panels' stylesheet without its comments, so prose naming a token does not count. */
const css = readFileSync(resolve(__dirname, '../phonePanels.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(selector)
  expect(at, `rule "${selector}"`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
})

const noop = (): void => undefined

describe('phone list rows on the shared row primitive (§9.34)', () => {
  it('is the .zen-v2-row with the .zen-phone-row modifier and nothing else of its own', () => {
    const el = render(
      <PhoneListRow
        icon={<span data-glyph />}
        title="Coffee - Wikipedia"
        subtitle="en.wikipedia.org · 2:38 PM"
        onTap={noop}
      />
    )
    const row = el.querySelector<HTMLElement>('.zen-v2-row')!
    expect(row).not.toBeNull()
    expect(row.classList.contains('zen-phone-row')).toBe(true)
    expect([...row.classList].filter((c) => c.startsWith('zen-'))).toEqual([
      'zen-v2-row',
      'zen-phone-row'
    ])
    // The two-line floor is the modifier's one geometry addition; the rest is the primitive's.
    expect(row.getAttribute('data-two-line')).toBe('true')
    expect(rule(".zen-v2-row.zen-phone-row[data-two-line='true']")).toMatch(
      /min-height: var\(--v2-row-two-line\)/
    )
    // The accessible row is the first child and the target: the whole row is a target.
    const main = row.firstElementChild!
    expect(main.getAttribute('role')).toBe('button')
    expect(main.getAttribute('aria-label')).toBe('Coffee - Wikipedia')
    expect(main.getAttribute('tabindex')).toBe('0')
  })

  it('draws no leading box for a row without a glyph (§10.4: a bare list has no glyph column)', () => {
    const el = render(
      <PhoneListRow title="Work laptop" subtitle="Last active 2 h ago" onTap={noop} />
    )
    const main = el.querySelector<HTMLElement>('.zen-list-main')!
    // The text is the accessible row's first child: nothing stands where a glyph would, so the
    // title starts at the gutter rather than 32 in from it.
    expect(el.querySelector('.zen-list-lead')).toBeNull()
    expect(main.firstElementChild!.classList.contains('zen-list-text')).toBe(true)
    expect(main.getAttribute('aria-label')).toBe('Work laptop')
    // While rows are being picked the checkbox stands in the lead's place all the same.
    const picking = render(<PhoneListRow title="Work laptop" selecting onTap={noop} />)
    expect(
      picking
        .querySelector('.zen-list-main')!
        .firstElementChild!.classList.contains('zen-v2-checkbox')
    ).toBe(true)
  })

  it('draws a picked row in the --v2-selected fill with the accent-filled checkbox (§9.6)', () => {
    const el = render(
      <PhoneListRow
        icon={<span data-glyph />}
        title="Coffee - Wikipedia"
        subtitle="en.wikipedia.org · 2:38 PM"
        selecting
        selected
        onTap={noop}
      />
    )
    const row = el.querySelector<HTMLElement>('.zen-v2-row.zen-phone-row')!
    expect(row.getAttribute('data-selected')).toBe('true')
    const main = row.firstElementChild!
    expect(main.getAttribute('role')).toBe('checkbox')
    expect(main.getAttribute('aria-checked')).toBe('true')
    // The checkbox is the shared primitive in its span form (§9.34): a presentational span that
    // is a direct child of the accessible row carrying `aria-checked`, which is what the
    // primitive's `[aria-checked='true'] > .zen-v2-checkbox` draws on – no input, no local copy
    // of the box. It stands where the glyph stood; the glyph has made way for it.
    const box = main.firstElementChild!
    expect([...box.classList]).toEqual(['zen-v2-checkbox'])
    expect(box.getAttribute('aria-hidden')).toBe('true')
    expect(box.childElementCount).toBe(0)
    expect(box.parentElement!.getAttribute('aria-checked')).toBe('true')
    expect(el.querySelector('[data-glyph]')).toBeNull()
    expect(el.querySelector('.zen-list-lead')).toBeNull()
    // The fill is the token, held through a press: the selection outranks the press fill.
    const selected = rule(".zen-v2-row.zen-phone-row[data-selected='true']")
    expect(selected).toMatch(/background: var\(--v2-selected\)/)
    expect(css).toMatch(/\.zen-v2-row\.zen-phone-row\[data-selected='true'\]:active/)
    expect(css).not.toMatch(/--v2-selection\b|--v2-nav-active\b/)
    // The panels draw no checkbox of their own: the one rule about it seats the primitive on
    // the first text line (§9.2) in this centring row, and the primitive's own rule fills it.
    expect(css).not.toMatch(/zen-list-checkbox|data-checkbox|data-checked/)
    expect(rule('.zen-list-main > .zen-v2-checkbox').trim()).toBe('align-self: flex-start;')
    const main_css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    expect(main_css).toMatch(
      /\[aria-checked='true'\] > \.zen-v2-checkbox \{\n {2}background: var\(--v2-accent\);/
    )
    // An unpicked row while picking: the same span, drawn off by the same rule.
    const off = render(
      <PhoneListRow icon={<span data-glyph />} title="Tea - Wikipedia" selecting onTap={noop} />
    )
    const offMain = off.querySelector<HTMLElement>('.zen-list-main')!
    expect(offMain.getAttribute('aria-checked')).toBe('false')
    expect([...offMain.firstElementChild!.classList]).toEqual(['zen-v2-checkbox'])
  })

  it('places a row action as the shared icon button beside the accessible row, not inside it', () => {
    const el = render(
      <PhoneListRow
        icon={<span data-glyph />}
        title="Hacker News"
        subtitle="news.ycombinator.com"
        trailing={
          <PhoneIconButton label="More options for Hacker News" onClick={noop}>
            <svg />
          </PhoneIconButton>
        }
        onTap={noop}
      />
    )
    const row = el.querySelector<HTMLElement>('.zen-v2-row.zen-phone-row')!
    const action = row.querySelector<HTMLButtonElement>(
      'button[aria-label="More options for Hacker News"]'
    )!
    expect(action).not.toBeNull()
    expect([...action.classList]).toEqual(['zen-v2-icon-button'])
    expect(action.closest('[role="button"]')).toBeNull()
    expect(action.parentElement!.classList.contains('zen-list-trailing')).toBe(true)
    // While rows are being picked the action makes way for the checkbox.
    const picking = render(
      <PhoneListRow
        icon={<span />}
        title="Hacker News"
        selecting
        trailing={
          <PhoneIconButton label="More options for Hacker News" onClick={noop}>
            <svg />
          </PhoneIconButton>
        }
        onTap={noop}
      />
    )
    expect(picking.querySelector('.zen-v2-icon-button')).toBeNull()
  })

  it('gives a destructive action row the danger ink through the modifier (§10.4)', () => {
    const el = render(<PhoneListRow icon={<span />} title="Clear history" danger onTap={noop} />)
    const row = el.querySelector<HTMLElement>('.zen-v2-row.zen-phone-row')!
    expect(row.hasAttribute('data-danger')).toBe(true)
    expect(row.getAttribute('data-two-line')).toBe('false')
    expect(rule('.zen-v2-row.zen-phone-row[data-danger]')).toMatch(/color: var\(--v2-danger\)/)
  })

  it('keeps a disabled row laid out at the one number, reachable, and deaf to a tap (§9.30)', () => {
    let taps = 0
    let holds = 0
    const el = render(
      <PhoneListRow
        icon={<span />}
        title="Blocker"
        disabled
        onTap={() => taps++}
        onLongPress={() => holds++}
      />
    )
    const row = el.querySelector<HTMLElement>('.zen-v2-row.zen-phone-row')!
    expect(row.hasAttribute('data-disabled')).toBe(true)
    // `aria-disabled` on the accessible row, not `disabled`: it stays in the order and keeps its
    // hold (the desktop's action button keeps its context menu the same way).
    const main = row.firstElementChild!
    expect(main.getAttribute('aria-disabled')).toBe('true')
    expect(main.getAttribute('tabindex')).toBe('0')
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(taps).toBe(0)
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(holds).toBe(1)
    // Opacity .4 on the whole row, no fill on a press, and the hover fill gated on a mouse.
    expect(rule('.zen-v2-row.zen-phone-row[data-disabled]')).toMatch(/opacity: 0\.4/)
    expect(rule('.zen-v2-row.zen-phone-row[data-disabled]:active')).toMatch(
      /background: transparent/
    )
    const hover = css.indexOf('.zen-v2-row.zen-phone-row[data-disabled]:hover')
    expect(hover).toBeGreaterThan(0)
    expect(css.lastIndexOf('@media (hover: hover)', hover)).toBeGreaterThan(
      css.lastIndexOf('}', hover)
    )
  })

  it('makes no static row: headings and empty notes are not rows, and every row is a target', () => {
    const el = render(
      <div>
        <PhoneGroupHeading>Yesterday</PhoneGroupHeading>
        <PhoneListRow
          icon={<span />}
          title="Tea - Wikipedia"
          subtitle="en.wikipedia.org"
          onTap={noop}
        />
        <PhoneListRow icon={<span />} title="Reading" onTap={noop} />
        <PhoneEmptyNote action={{ label: 'Import bookmarks', onSelect: noop }}>
          Pages you bookmark will show up here
        </PhoneEmptyNote>
      </div>
    )
    // The heading is the shared heading (15/600) with this list's beat, not a row in disguise.
    const heading = el.querySelector<HTMLElement>('h3')!
    expect([...heading.classList]).toEqual(['zen-v2-heading', 'zen-list-heading'])
    expect(heading.classList.contains('zen-v2-row')).toBe(false)
    // The empty note is the §9.17 composition for a list, its follow-up the shared button.
    const empty = el.querySelector<HTMLElement>('.zen-phone-empty')!
    expect(empty.classList.contains('zen-v2-row')).toBe(false)
    expect(empty.querySelector('button')!.classList.contains('zen-v2-button')).toBe(true)
    // Nothing in the panels' vocabulary is a static row, and every row primitive is a target.
    expect(el.querySelector('[data-static]')).toBeNull()
    const rows = [...el.querySelectorAll<HTMLElement>('.zen-v2-row')]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.hasAttribute('data-static')).toBe(false)
      expect(row.firstElementChild!.getAttribute('role')).toBe('button')
    }
    expect(css).not.toMatch(/data-static/)
  })
})

describe('the selection header (§9.6)', () => {
  // A button's name: its label, or the words it shows (the §9.18 button carries its own).
  const buttons = (el: ParentNode): string[] =>
    [...el.querySelectorAll<HTMLElement>('button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent!
    )
  const bulk = (el: ParentNode): HTMLButtonElement =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      /select all/i.test(b.textContent ?? '')
    )!

  it('offers Select all as the one trailing secondary button after the list’s actions, with the count, until every shown row is picked', () => {
    const picks: boolean[] = []
    const el = render(
      <PhoneSelectionHeader
        count={2}
        total={5}
        onSelectAll={(all) => picks.push(all)}
        onExit={noop}
        actions={
          <PhoneIconButton label="Remove from history" onClick={noop}>
            <svg />
          </PhoneIconButton>
        }
      />
    )
    expect(el.querySelector('h2')!.textContent).toBe('2 selected')
    expect(buttons(el)).toEqual(['Stop selecting', 'Remove from history', 'Select all'])
    const selectAllButton = bulk(el)
    // §9.6: the bulk toggle is a §9.18 secondary `zen-v2-button` with the words, never an
    // icon button or a text button; the same composition as the overview's select-tabs header.
    expect(selectAllButton.classList.contains('zen-v2-button')).toBe(true)
    expect(selectAllButton.hasAttribute('data-primary')).toBe(false)
    expect(selectAllButton.classList.contains('zen-v2-icon-button')).toBe(false)
    act(() => selectAllButton.click())
    expect(picks).toEqual([true])
  })

  it('flips to Deselect all once every shown row is picked, and asks for the unpick', () => {
    const picks: boolean[] = []
    const el = render(
      <PhoneSelectionHeader
        count={5}
        total={5}
        onSelectAll={(all) => picks.push(all)}
        onExit={noop}
        actions={null}
      />
    )
    expect(buttons(el)).toEqual(['Stop selecting', 'Deselect all'])
    act(() => bulk(el).click())
    expect(picks).toEqual([false])
  })

  it('has no Select all for a list that does not ask for one, and a disabled one over an empty list', () => {
    const el = render(<PhoneSelectionHeader count={1} onExit={noop} actions={null} />)
    expect(buttons(el)).toEqual(['Stop selecting'])
    const empty = render(
      <PhoneSelectionHeader count={0} total={0} onSelectAll={noop} onExit={noop} actions={null} />
    )
    expect(bulk(empty).disabled).toBe(true)
  })
})
