// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PhoneEmptyNote, PhoneGroupHeading, PhoneIconButton, PhoneListRow } from '../PhoneList'

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
    // The checkbox stands in the leading box, filled; the glyph has made way for it.
    expect(el.querySelector('.zen-list-checkbox[data-checked="true"]')).not.toBeNull()
    expect(el.querySelector('[data-glyph]')).toBeNull()
    // The fill is the token, held through a press: the selection outranks the press fill.
    const selected = rule(".zen-v2-row.zen-phone-row[data-selected='true']")
    expect(selected).toMatch(/background: var\(--v2-selected\)/)
    expect(css).toMatch(/\.zen-v2-row\.zen-phone-row\[data-selected='true'\]:active/)
    expect(css).not.toMatch(/--v2-selection\b|--v2-nav-active\b/)
    expect(rule(".zen-list-checkbox[data-checked='true']")).toMatch(
      /background: var\(--v2-accent\)/
    )
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
