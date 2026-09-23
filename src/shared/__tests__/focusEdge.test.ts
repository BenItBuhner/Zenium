// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { edgeControl, focusEdge, tabbablesIn } from '../focusEdge'

/**
 * Where Tab lands as it enters a document (A11Y-09's remainder): the document's first tabbable
 * control forward, its last backward, in sequential focus order as far as a script reads it.
 */

/** happy-dom lays nothing out: every element is on screen unless the test hides it. */
const HIDDEN = 'data-hidden'
function onScreen(this: Element): DOMRect[] {
  return this.closest(`[${HIDDEN}]`) ? [] : [new DOMRect(0, 0, 10, 10)]
}

function mount(html: string): void {
  document.body.innerHTML = html
}

const ids = (elements: Element[]): string[] => elements.map((el) => el.id)

beforeEach(() => {
  Element.prototype.getClientRects = onScreen as unknown as typeof Element.prototype.getClientRects
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the tabbable order a Tab from outside lands in', () => {
  it('walks links, controls, frames, summaries, media with controls, tabindex and editable text in document order', () => {
    mount(`
      <a id="link" href="#">link</a>
      <a id="anchor">no href</a>
      <button id="button">button</button>
      <input id="field">
      <select id="select"></select>
      <textarea id="area"></textarea>
      <iframe id="frame"></iframe>
      <details><summary id="summary">more</summary><a id="inside-closed" href="#" ${HIDDEN}>hidden</a></details>
      <audio id="audio" controls></audio>
      <audio id="audio-plain"></audio>
      <div id="tabbable" tabindex="0">div</div>
      <div id="editable" contenteditable="true">text</div>
      <div id="not-editable" contenteditable="false">text</div>
    `)
    expect(ids(tabbablesIn(document))).toEqual([
      'link',
      'button',
      'field',
      'select',
      'area',
      'frame',
      'summary',
      'audio',
      'tabbable',
      'editable'
    ])
  })

  it('skips a negative tabindex, a disabled control, a disabled fieldset’s controls, a hidden input and what has no box or is hidden', () => {
    mount(`
      <button id="a">a</button>
      <button id="skipped" tabindex="-1">skipped</button>
      <button id="disabled" disabled>disabled</button>
      <fieldset disabled><legend><button id="legend-button">in the legend</button></legend><input id="in-disabled-fieldset"></fieldset>
      <input id="hidden-input" type="hidden">
      <div ${HIDDEN}><button id="no-box">display none</button></div>
      <button id="invisible" style="visibility: hidden">invisible</button>
      <div inert><button id="inert">inert</button></div>
      <div aria-hidden="true"><button id="aria-hidden">hidden from the tree</button></div>
      <button id="z">z</button>
    `)
    expect(ids(tabbablesIn(document))).toEqual(['a', 'legend-button', 'z'])
  })

  it('puts a positive tabindex first, ascending, stable within a value, then the rest in document order', () => {
    mount(`
      <button id="plain-1">1</button>
      <button id="third" tabindex="3">3</button>
      <button id="first" tabindex="1">1</button>
      <button id="plain-2">2</button>
      <button id="second-a" tabindex="2">2a</button>
      <button id="second-b" tabindex="2">2b</button>
    `)
    expect(ids(tabbablesIn(document))).toEqual([
      'first',
      'second-a',
      'second-b',
      'third',
      'plain-1',
      'plain-2'
    ])
  })
})

describe('focusEdge', () => {
  it('lands a Tab on the first control and a Shift+Tab on the last', () => {
    mount(`<a id="first" href="#">first</a><button id="middle">middle</button><input id="last">`)
    expect(edgeControl('first', document)?.id).toBe('first')
    expect(edgeControl('last', document)?.id).toBe('last')
    expect(focusEdge('first', document)?.id).toBe('first')
    expect(document.activeElement?.id).toBe('first')
    expect(focusEdge('last', document)?.id).toBe('last')
    expect(document.activeElement?.id).toBe('last')
  })

  it('reads a subtree when given one, and answers null for a document with nothing to land on', () => {
    mount(
      `<button id="outside">outside</button><div id="root"><button id="inside">inside</button></div>`
    )
    const root = document.getElementById('root')!
    expect(edgeControl('first', root)?.id).toBe('inside')
    expect(edgeControl('last', root)?.id).toBe('inside')
    mount(`<p>nothing to focus</p><button disabled>no</button>`)
    expect(focusEdge('first', document)).toBeNull()
    expect(focusEdge('last', document)).toBeNull()
  })
})
