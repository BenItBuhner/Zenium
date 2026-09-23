// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { installEditingFocusReporter, isEditingElement } from '../editingFocus'

/*
 * The page's word on whether a text field has the keyboard (history-14, `shared/editingFocus`):
 * one report per settled focus change, from a frame that holds the keyboard, about its own
 * document. `KeyboardHandler` reads it to leave ⌘← / ⌘→ to the field.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

/** happy-dom's `hasFocus` is not tied to the test's focus: the test says whether the frame has it. */
function frameFocus(has: boolean): void {
  Object.defineProperty(document, 'hasFocus', { value: () => has, configurable: true })
}

let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  document.body.innerHTML = ''
  frameFocus(true)
  // The nested-frame test pins `activeElement`; give the document its own back.
  delete (document as { activeElement?: Element | null }).activeElement
})

function install(): boolean[] {
  const sent: boolean[] = []
  uninstall = installEditingFocusReporter({ send: (editing) => sent.push(editing) })
  return sent
}

describe('isEditingElement', () => {
  it('is true for text-like inputs, textareas and editable content', () => {
    document.body.innerHTML = `
      <input id="text"><input id="search" type="search"><input id="password" type="password">
      <textarea id="area"></textarea><div id="rich" contenteditable="true"></div>
      <input id="check" type="checkbox"><input id="go" type="submit"><button id="btn"></button>
      <select id="sel"></select><a id="link" href="#">x</a><div id="plain"></div>`
    const el = (id: string): Element => document.getElementById(id)!
    for (const id of ['text', 'search', 'password', 'area', 'rich'])
      expect(isEditingElement(el(id)), id).toBe(true)
    for (const id of ['check', 'go', 'btn', 'sel', 'link', 'plain'])
      expect(isEditingElement(el(id)), id).toBe(false)
    expect(isEditingElement(null)).toBe(false)
  })
})

describe('installEditingFocusReporter', () => {
  it('reports the document\u2019s state once installed, and after each focus change', async () => {
    document.body.innerHTML = '<input id="field"><button id="btn"></button>'
    frameFocus(true)
    const sent = install()
    await settle()
    expect(sent).toEqual([false])
    document.getElementById('field')!.focus()
    await settle()
    expect(sent).toEqual([false, true])
    document.getElementById('btn')!.focus()
    await settle()
    expect(sent).toEqual([false, true, false])
  })

  it('folds the focusout and focusin of one move into one report', async () => {
    document.body.innerHTML = '<input id="a"><input id="b">'
    const sent = install()
    await settle()
    document.getElementById('a')!.focus()
    await settle()
    document.getElementById('b')!.focus()
    await settle()
    expect(sent).toEqual([false, true, true])
  })

  it('says nothing while the frame does not hold the keyboard', async () => {
    document.body.innerHTML = '<input id="field">'
    frameFocus(false)
    const sent = install()
    document.getElementById('field')!.focus()
    await settle()
    expect(sent).toEqual([])
    // The frame gets the keyboard back: its state is reported anew.
    frameFocus(true)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(sent).toEqual([true])
  })

  it('leaves the keyboard on a nested frame to that frame\u2019s document', async () => {
    document.body.innerHTML = '<input id="field"><iframe id="frame"></iframe>'
    const sent = install()
    await settle()
    document.getElementById('field')!.focus()
    await settle()
    const frame = document.getElementById('frame')! as HTMLIFrameElement
    // The nested frame takes the keyboard; the parent's active element is the frame itself.
    frame.focus()
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    document.dispatchEvent(new Event('focusin'))
    await settle()
    expect(sent).toEqual([false, true])
  })

  it('reports again when the document is shown from the back-forward cache', async () => {
    document.body.innerHTML = '<input id="field">'
    const sent = install()
    await settle()
    document.getElementById('field')!.focus()
    await settle()
    window.dispatchEvent(new Event('pageshow'))
    await settle()
    expect(sent).toEqual([false, true, true])
  })

  it('stops reporting once uninstalled', async () => {
    document.body.innerHTML = '<input id="field">'
    const sent = install()
    await settle()
    uninstall!()
    uninstall = null
    document.getElementById('field')!.focus()
    await settle()
    expect(sent).toEqual([false])
  })
})
