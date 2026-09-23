// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { HELD, focusableIn, wrapTab } from '../popover'

/*
 * Tab inside a surface (§9.22) as the levels of a sheet need it (§10.4, W5-17): a control under
 * a `hidden`, an `aria-hidden` or an `inert` subtree – the pane of a level that is away, the pane
 * on its way out, a sheet under another – is no stop and no wrap point; and a held container
 * inside the root (a confirmation level, `role="alertdialog"` at `tabIndex -1`) is entered at
 * its own first control by Tab and its own last by Shift+Tab, not at the root's ends.
 */

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const tab = (shift = false): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true })
const ids = (els: HTMLElement[]): string[] => els.map((el) => el.id)

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusableIn', () => {
  it('skips a control under a hidden, an aria-hidden or an inert ancestor, and keeps the rest in order', () => {
    const root = mount(`
      <button id="a">A</button>
      <section hidden><button id="away">away</button></section>
      <section aria-hidden="true"><button id="leaving">leaving</button><a id="link" href="#">l</a></section>
      <section inert><input id="under" /></section>
      <section><button id="b">B</button><button id="c" hidden>C</button></section>
      <button id="d" disabled>D</button>
      <div id="e" tabindex="0">E</div>
      <div id="f" tabindex="-1">F</div>
    `)
    expect(ids(focusableIn(root))).toEqual(['a', 'b', 'e'])
  })
})

describe('wrapTab', () => {
  it('names the held container by the mark the no-ring rule reads', () => {
    expect(HELD).toBe('[role="dialog"][tabindex="-1"], [role="alertdialog"][tabindex="-1"]')
  })

  it('wraps at the ends and enters at the end the key heads for from outside or from the root itself', () => {
    const root = mount(
      `<button id="first">1</button><button id="mid">2</button><button id="last">3</button>`
    )
    root.tabIndex = -1
    const first = root.querySelector<HTMLElement>('#first')!
    const last = root.querySelector<HTMLElement>('#last')!
    // From outside: Tab enters at the first, Shift+Tab at the last.
    document.body.focus()
    let e = tab()
    wrapTab(root, e)
    expect(document.activeElement).toBe(first)
    expect(e.defaultPrevented).toBe(true)
    // At the last, Tab wraps to the first; at the first, Shift+Tab to the last.
    last.focus()
    wrapTab(root, tab())
    expect(document.activeElement).toBe(first)
    wrapTab(root, tab(true))
    expect(document.activeElement).toBe(last)
    // From the root itself (a sheet holding its container) the key enters at the root's ends.
    root.focus()
    wrapTab(root, tab())
    expect(document.activeElement).toBe(first)
    root.focus()
    e = tab(true)
    wrapTab(root, e)
    expect(document.activeElement).toBe(last)
    // A step inside is the browser's.
    first.focus()
    e = tab()
    wrapTab(root, e)
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(first)
  })

  it('enters a held container inside the root at that container’s own first control, and Shift+Tab at its last (§10.4)', () => {
    // The sheet: its grabber first, then a confirmation level – a dialog of its own – and, away
    // and aria-hidden, the pane the level came from.
    const root = mount(`
      <button id="grabber" aria-label="Dismiss">g</button>
      <section id="level" role="alertdialog" tabindex="-1">
        <button id="cancel">Cancel</button><button id="verb">Clear cookies</button>
      </section>
      <section aria-hidden="true"><button id="row">Clear cookies</button></section>
    `)
    root.tabIndex = -1
    const level = root.querySelector<HTMLElement>('#level')!
    const cancel = root.querySelector<HTMLElement>('#cancel')!
    const verb = root.querySelector<HTMLElement>('#verb')!
    const grabber = root.querySelector<HTMLElement>('#grabber')!
    level.focus()
    expect(document.activeElement).toBe(level)
    let e = tab()
    wrapTab(root, e)
    expect(document.activeElement).toBe(cancel)
    expect(e.defaultPrevented).toBe(true)
    // Then the verb is the browser's step; at the verb – the root's last – Tab wraps to the grabber.
    verb.focus()
    wrapTab(root, tab())
    expect(document.activeElement).toBe(grabber)
    // Shift+Tab from the held container: its own last, the verb.
    level.focus()
    e = tab(true)
    wrapTab(root, e)
    expect(document.activeElement).toBe(verb)
    expect(e.defaultPrevented).toBe(true)
    // A held container with nothing of its own falls back to the root's ends.
    const empty = document.createElement('div')
    empty.setAttribute('role', 'dialog')
    empty.tabIndex = -1
    root.appendChild(empty)
    empty.focus()
    wrapTab(root, tab())
    expect(document.activeElement).toBe(grabber)
    // A plain container inside the root (no held mark) enters at the root's ends as before.
    const plain = document.createElement('div')
    plain.tabIndex = -1
    root.appendChild(plain)
    plain.focus()
    wrapTab(root, tab(true))
    expect(document.activeElement).toBe(verb)
  })
})
