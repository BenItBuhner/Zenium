// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { hopTab, tabbableAfter, tabbables, wrapTab } from '../popover'

/** A synthetic Tab as the container's `onKeyDown` sees it. */
function tab(shift = false): React.KeyboardEvent & { prevented: boolean } {
  const e = {
    key: 'Tab',
    shiftKey: shift,
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  return e as unknown as React.KeyboardEvent & { prevented: boolean }
}

/**
 * A toolbar with the anchor and a button after it, then – at the end of the document, as the
 * chrome layer is – the popover with two rows and its footer control.
 */
function mount(): {
  anchor: HTMLElement
  after: HTMLElement
  root: HTMLElement
  rows: HTMLElement[]
  footer: HTMLElement
} {
  document.body.innerHTML = `
    <div class="toolbar">
      <button id="before">before</button>
      <button id="anchor">anchor</button>
      <button id="after">after</button>
    </div>
    <div id="layer">
      <div id="root" tabindex="-1">
        <ul><li id="r1" tabindex="0">one</li><li id="r2" tabindex="0">two</li></ul>
        <button id="footer">Show all</button>
      </div>
    </div>`
  const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
  return {
    anchor: el('anchor'),
    after: el('after'),
    root: el('root'),
    rows: [el('r1'), el('r2')],
    footer: el('footer')
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('tabbables', () => {
  it('lists the tabbable elements in document order, the -1 panel left out', () => {
    const { root, rows, footer } = mount()
    expect(tabbables(root)).toEqual([...rows, footer])
    expect(tabbables(document.body).map((e) => e.id)).toEqual([
      'before',
      'anchor',
      'after',
      'r1',
      'r2',
      'footer'
    ])
  })
})

describe('tabbableAfter', () => {
  it('is the next tabbable after the anchor outside the popover', () => {
    const { anchor, after, root } = mount()
    expect(tabbableAfter(anchor, root)).toBe(after)
  })

  it('is null when nothing tabbable follows the anchor but the popover itself', () => {
    const { anchor, after, root } = mount()
    after.remove()
    expect(tabbableAfter(anchor, root)).toBeNull()
  })
})

describe('hopTab: a notice stands right after its anchor in the Tab order (§9.22)', () => {
  it('Tab at the last element moves on to what follows the anchor, not back to the first', () => {
    const { anchor, after, root, footer } = mount()
    footer.focus()
    const e = tab()
    hopTab(e, root, anchor)
    expect(e.prevented).toBe(true)
    expect(document.activeElement).toBe(after)
  })

  it('Shift+Tab at the first element returns to the anchor', () => {
    const { anchor, root, rows } = mount()
    rows[0]?.focus()
    const e = tab(true)
    hopTab(e, root, anchor)
    expect(e.prevented).toBe(true)
    expect(document.activeElement).toBe(anchor)
  })

  it('inside, Tab is left to the browser', () => {
    const { anchor, root, rows } = mount()
    rows[0]?.focus()
    const forward = tab()
    hopTab(forward, root, anchor)
    expect(forward.prevented).toBe(false)
    rows[1]?.focus()
    const back = tab(true)
    hopTab(back, root, anchor)
    expect(back.prevented).toBe(false)
    expect(document.activeElement).toBe(rows[1])
  })

  it('with nothing after the anchor the browser keeps its Tab; other keys are ignored', () => {
    const { anchor, after, root, footer } = mount()
    after.remove()
    footer.focus()
    const e = tab()
    hopTab(e, root, anchor)
    expect(e.prevented).toBe(false)
    const other = { ...tab(), key: 'Enter' } as unknown as React.KeyboardEvent & {
      prevented: boolean
    }
    hopTab(other, root, anchor)
    expect(other.prevented).toBe(false)
  })
})

describe('wrapTab: a popover the user opened keeps the keyboard inside (§9.22)', () => {
  it('Tab at the last element lands on the first, Shift+Tab at the first on the last', () => {
    const { root, rows, footer } = mount()
    footer.focus()
    const forward = tab()
    wrapTab(forward, root)
    expect(forward.prevented).toBe(true)
    expect(document.activeElement).toBe(rows[0])
    const back = tab(true)
    wrapTab(back, root)
    expect(back.prevented).toBe(true)
    expect(document.activeElement).toBe(footer)
  })
})
