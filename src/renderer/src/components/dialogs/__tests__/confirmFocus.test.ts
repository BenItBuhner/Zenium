// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OWN_ENTER,
  answerEnter,
  holdFocus,
  releaseFocus,
  resolveReturnFocus
} from '../confirmFocus'

/*
 * The confirmation's keyboard machinery on its own (§9.22 as amended on #392, the #401
 * rulings), shared by the frame's prompt and the level of a sheet (§10.4, W5-17): Enter answered
 * from the container, the hold on entry and the one-hop return on the leave.
 */

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const enter = (init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true, ...init })

afterEach(() => {
  document.body.innerHTML = ''
})

describe('answerEnter', () => {
  it('on a destructive prompt swallows Enter from the container and confirms nothing', () => {
    const root = mount('<div role="alertdialog" tabindex="-1"></div>')
      .firstElementChild as HTMLElement
    const confirm = vi.fn()
    const e = enter()
    let answered = false
    root.addEventListener('keydown', (ev) => {
      answered = answerEnter(ev, true, confirm)
    })
    root.dispatchEvent(e)
    expect(answered).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('on a plain prompt Enter from the container is the primary’s', () => {
    const confirm = vi.fn()
    const e = enter()
    expect(answerEnter(e, false, confirm)).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(e.defaultPrevented).toBe(true)
  })

  it('leaves a modified, repeated or composing Enter, and any other key, alone', () => {
    const confirm = vi.fn()
    for (const init of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { repeat: true },
      { isComposing: true },
      { key: ' ' },
      { key: 'Escape' }
    ] as KeyboardEventInit[]) {
      const e = enter(init)
      expect(answerEnter(e, false, confirm), JSON.stringify(init)).toBe(false)
      expect(e.defaultPrevented, JSON.stringify(init)).toBe(false)
    }
    expect(confirm).not.toHaveBeenCalled()
  })

  it('leaves Enter on a control that answers its own – a button, a link, a select, a textarea', () => {
    expect(OWN_ENTER).toBe('button, a[href], [role="button"], select, textarea')
    const root = mount(
      '<div role="alertdialog" tabindex="-1"><button id="verb"><span id="inner">Clear</span></button><a id="link" href="#">x</a><input id="check" type="checkbox" /></div>'
    )
    const confirm = vi.fn()
    const outcomes: boolean[] = []
    ;(root.firstElementChild as HTMLElement).addEventListener('keydown', (ev) => {
      outcomes.push(answerEnter(ev, false, confirm))
    })
    // From inside the button (the target may be a child of it) and from the link: theirs.
    root.querySelector('#inner')!.dispatchEvent(enter())
    root.querySelector('#link')!.dispatchEvent(enter())
    expect(outcomes).toEqual([false, false])
    expect(confirm).not.toHaveBeenCalled()
    // From a check row: the prompt's.
    root.querySelector('#check')!.dispatchEvent(enter())
    expect(outcomes).toEqual([false, false, true])
    expect(confirm).toHaveBeenCalledOnce()
  })
})

describe('holdFocus', () => {
  it('moves the focus to the container and returns what held it – never body, never something inside', () => {
    const page = mount('<button id="opener">Clear</button>')
    const opener = page.querySelector<HTMLElement>('#opener')!
    const root = mount(
      '<div id="root" role="alertdialog" tabindex="-1"><button id="c">Cancel</button></div>'
    ).firstElementChild as HTMLElement
    opener.focus()
    expect(holdFocus(root)).toBe(opener)
    expect(document.activeElement).toBe(root)
    // From body: no opener.
    document.body.focus()
    expect(holdFocus(root)).toBeNull()
    expect(document.activeElement).toBe(root)
    // From a control of the prompt itself: none either.
    root.querySelector<HTMLElement>('#c')!.focus()
    expect(holdFocus(root)).toBeNull()
    expect(document.activeElement).toBe(root)
  })

  it('lands where a host names instead – a detail level on its first row – and still remembers the opener', () => {
    const page = mount('<button id="opener">Connection</button>')
    const opener = page.querySelector<HTMLElement>('#opener')!
    const pane = mount('<section id="pane"><button id="row">Issued to</button></section>')
      .firstElementChild as HTMLElement
    const row = pane.querySelector<HTMLElement>('#row')!
    opener.focus()
    expect(holdFocus(pane, row)).toBe(opener)
    expect(document.activeElement).toBe(row)
  })
})

describe('resolveReturnFocus', () => {
  it('reads the consumer’s wish: the opener by default, an element or a function, or none', () => {
    const el = document.createElement('button')
    const opener = document.createElement('button')
    expect(resolveReturnFocus(undefined, opener)).toBe(opener)
    expect(resolveReturnFocus(undefined, null)).toBeNull()
    expect(resolveReturnFocus(false, opener)).toBeNull()
    expect(resolveReturnFocus(el, opener)).toBe(el)
    expect(resolveReturnFocus(() => el, opener)).toBe(el)
    expect(resolveReturnFocus(() => null, opener)).toBeNull()
    expect(resolveReturnFocus(() => undefined, opener)).toBeNull()
  })
})

describe('releaseFocus', () => {
  function stage(): {
    root: HTMLElement
    verb: HTMLElement
    opener: HTMLElement
    other: HTMLElement
    sheet: HTMLElement
  } {
    const sheet = mount(
      '<div id="sheet" role="dialog" tabindex="-1"><button id="opener">Clear cookies</button><div id="root" role="alertdialog" tabindex="-1"><button id="verb">Clear</button></div></div>'
    ).firstElementChild as HTMLElement
    const other = mount('<button id="other">elsewhere</button>').firstElementChild as HTMLElement
    return {
      sheet,
      root: sheet.querySelector<HTMLElement>('#root')!,
      verb: sheet.querySelector<HTMLElement>('#verb')!,
      opener: sheet.querySelector<HTMLElement>('#opener')!,
      other
    }
  }

  it('gives the keyboard back one hop when the leave loses it: from the prompt, from body, or parked on a held container', () => {
    const { root, verb, opener, sheet } = stage()
    root.focus()
    expect(releaseFocus(root, opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
    verb.focus()
    expect(releaseFocus(root, opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
    document.body.focus()
    expect(releaseFocus(root, opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
    // Parked on the sheet's own held container: at no control, so the row takes it.
    sheet.focus()
    expect(document.activeElement).toBe(sheet)
    expect(releaseFocus(root, opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('leaves a focus the user or a dialog over the way out has already placed', () => {
    const { root, opener, other } = stage()
    other.focus()
    expect(releaseFocus(root, opener)).toBe(false)
    expect(document.activeElement).toBe(other)
  })

  it('treats a focus under an inert or a leaving subtree as lost', () => {
    const { root, opener, other } = stage()
    other.focus()
    other.parentElement!.setAttribute('inert', '')
    expect(releaseFocus(root, opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
    other.parentElement!.removeAttribute('inert')
    other.parentElement!.setAttribute('data-leaving', '')
    other.focus()
    expect(releaseFocus(root, opener)).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('returns nothing to a target that is gone or was never named', () => {
    const { root, opener } = stage()
    root.focus()
    expect(releaseFocus(root, null)).toBe(false)
    expect(document.activeElement).toBe(root)
    opener.remove()
    expect(releaseFocus(root, opener)).toBe(false)
    expect(document.activeElement).toBe(root)
  })
})
