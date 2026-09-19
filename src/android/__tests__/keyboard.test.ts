// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installKeyboardPolicy, type KeyboardMessage } from '../keyboard'

/*
 * The chrome's keyboard policy on the device: `focusin` on a field asks the host for the
 * keyboard, `focusout` to nothing editable asks it down, and the busy form of §9.30 – a field
 * read-only while its value is applied, then refused, editable again and "focused" while it has
 * the focus already – gets a real focus change the next frame, so the WebView shows the keyboard
 * it hid for the read-only field. The frame loop is cranked by hand; the mutation records arrive
 * as microtasks, as in the browser.
 */

let sent: KeyboardMessage[] = []
let uninstall: (() => void) | null = null
const frames: Array<() => void> = []
/** The focus events the field saw, in order. */
let seen: string[] = []

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
}
const frame = (): void => {
  const pending = frames.splice(0)
  for (const cb of pending) cb()
}

function field(): HTMLInputElement {
  const input = document.createElement('input')
  document.body.appendChild(input)
  for (const type of ['focusin', 'focusout']) {
    input.addEventListener(type, () => seen.push(type))
  }
  return input
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  sent = []
  seen = []
  uninstall = installKeyboardPolicy((message) => sent.push(message))
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  frames.length = 0
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the keyboard follows the focus', () => {
  it('asks for the keyboard as a field takes the focus and asks it down as the focus leaves to nothing editable', () => {
    const name = field()
    const button = document.createElement('button')
    document.body.appendChild(button)
    name.focus()
    expect(sent).toEqual(['chrome.showKeyboard'])
    button.focus()
    expect(sent).toEqual(['chrome.showKeyboard', 'chrome.hideKeyboard'])
  })

  it('keeps it up from one field to the next', () => {
    const name = field()
    const address = field()
    name.focus()
    address.focus()
    expect(sent).toEqual(['chrome.showKeyboard', 'chrome.showKeyboard'])
  })
})

describe('a busy field turned editable again gets the keyboard back (§9.30)', () => {
  it('blurs and refocuses the still-focused field the frame after its readonly goes, asking for the keyboard once and never down', async () => {
    const passphrase = field()
    passphrase.focus()
    sent = []
    seen = []
    // The form is busy: the field is read-only (the WebView hides the keyboard for it).
    passphrase.readOnly = true
    await flush()
    expect(frames).toHaveLength(0)
    // Refused: editable again, cleared, and the surface's focus() on the focused field – a no-op.
    passphrase.readOnly = false
    passphrase.value = ''
    passphrase.focus()
    await flush()
    expect(frames).toHaveLength(1)
    expect(sent).toEqual([])
    frame()
    expect(seen).toEqual(['focusout', 'focusin'])
    expect(document.activeElement).toBe(passphrase)
    expect(sent).toEqual(['chrome.showKeyboard'])
  })

  it('leaves a field alone that lost the focus meanwhile, and one whose readonly only arrived', async () => {
    const passphrase = field()
    const cancel = document.createElement('button')
    document.body.appendChild(cancel)
    passphrase.focus()
    passphrase.readOnly = true
    await flush()
    cancel.focus()
    sent = []
    passphrase.readOnly = false
    await flush()
    expect(frames).toHaveLength(0)
    frame()
    expect(sent).toEqual([])
    expect(document.activeElement).toBe(cancel)

    // Focused and turning read-only is the keyboard going, Chromium's doing: nothing to swap.
    const other = field()
    other.focus()
    sent = []
    other.readOnly = true
    await flush()
    expect(frames).toHaveLength(0)
  })

  it('stands down when the focus moves before the frame, and when the surface swapped the focus itself', async () => {
    const passphrase = field()
    const cancel = document.createElement('button')
    document.body.appendChild(cancel)
    passphrase.focus()
    passphrase.readOnly = true
    await flush()
    passphrase.readOnly = false
    await flush()
    expect(frames).toHaveLength(1)
    cancel.focus()
    expect(frames).toHaveLength(0)
    sent = []
    frame()
    expect(sent).toEqual([])

    passphrase.focus()
    passphrase.readOnly = true
    await flush()
    passphrase.readOnly = false
    await flush()
    expect(frames).toHaveLength(1)
    // A surface doing the swap on its own: the focus change is there, the frame is dropped.
    passphrase.blur()
    passphrase.focus()
    expect(frames).toHaveLength(0)
    seen = []
    frame()
    expect(seen).toEqual([])
    expect(document.activeElement).toBe(passphrase)
  })
})
