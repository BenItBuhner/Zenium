// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { initialFocusIn, tabbablesIn, wrapTabTarget } from '../focusReach'

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root" tabindex="-1">${html}</div>`
  return document.getElementById('root') as HTMLElement
}

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('tabbablesIn', () => {
  it('lists enabled controls and links in document order, skipping tabindex -1 and hidden ones', () => {
    const root = mount(`
      <h2 id="title">Title</h2>
      <span id="chip" tabindex="-1"></span>
      <button id="open1">Open</button>
      <a id="plain">no href</a>
      <a id="link" href="#">link</a>
      <button id="off" disabled>Off</button>
      <input id="secret" type="hidden">
      <div hidden><button id="gone">Gone</button></div>
      <label><input id="allow" type="checkbox"> Allow</label>
      <button id="dismiss">Dismiss</button>
    `)
    expect(tabbablesIn(root).map((el) => el.id)).toEqual(['open1', 'link', 'allow', 'dismiss'])
  })

  it('counts a radio group once: its checked button, or the first when none is checked', () => {
    const root = mount(`
      <input id="r1" type="radio" name="cert">
      <input id="r2" type="radio" name="cert" checked>
      <input id="r3" type="radio" name="cert">
      <button id="cancel">Cancel</button>
    `)
    expect(tabbablesIn(root).map((el) => el.id)).toEqual(['r2', 'cancel'])
    ;(byId('r2') as HTMLInputElement).checked = false
    expect(tabbablesIn(root).map((el) => el.id)).toEqual(['r1', 'cancel'])
  })
})

describe('initialFocusIn', () => {
  it('is the first tabbable element', () => {
    const root = mount('<p>Summary</p><button id="open1">Open</button><button id="b">B</button>')
    expect(initialFocusIn(root).id).toBe('open1')
  })

  it('is the container itself when nothing inside is tabbable', () => {
    const root = mount('<h2>Title</h2><p>A notice.</p>')
    expect(initialFocusIn(root).id).toBe('root')
  })
})

describe('wrapTabTarget', () => {
  it('wraps forward from the last element and backward from the first, and stays out of the middle', () => {
    const root = mount(
      '<button id="a">A</button><button id="b">B</button><button id="c">C</button>'
    )
    expect(wrapTabTarget(root, byId('c'), false)?.id).toBe('a')
    expect(wrapTabTarget(root, byId('a'), true)?.id).toBe('c')
    expect(wrapTabTarget(root, byId('b'), false)).toBe(null)
    expect(wrapTabTarget(root, byId('b'), true)).toBe(null)
    expect(wrapTabTarget(root, byId('a'), false)).toBe(null)
  })

  it('leaves the focused container for its first element forward and its last backward', () => {
    const root = mount('<button id="a">A</button><button id="b">B</button>')
    expect(wrapTabTarget(root, root, false)?.id).toBe('a')
    expect(wrapTabTarget(root, root, true)?.id).toBe('b')
  })

  it('treats a radio group at either end as that end, whichever button holds focus', () => {
    const root = mount(`
      <input id="r1" type="radio" name="cert" checked>
      <input id="r2" type="radio" name="cert">
      <button id="cancel">Cancel</button>
      <button id="use">Use</button>
    `)
    expect(wrapTabTarget(root, byId('r2'), true)?.id).toBe('use')
    expect(wrapTabTarget(root, byId('r1'), true)?.id).toBe('use')
    expect(wrapTabTarget(root, byId('r2'), false)).toBe(null)
    expect(wrapTabTarget(root, byId('use'), false)?.id).toBe('r1')
  })

  it('keeps focus on the container when it holds nothing tabbable', () => {
    const root = mount('<p>Only a notice.</p>')
    expect(wrapTabTarget(root, root, false)).toBe(root)
  })
})
