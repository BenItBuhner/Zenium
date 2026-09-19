// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionPromptRequest } from '@shared/types'

/*
 * The phone form of the install / permissions prompt (§9.11, §9.23): the extension's warning
 * rows scroll in the sheet's body, and the two buttons sit in the sheet chassis' `footer` slot
 * under the scroller, so an extension that asks for a dozen permissions – whose rows fill the
 * sheet's first detent – still shows Cancel and Add extension without a scroll. The Android
 * sweep found Todoist's and Adblock Plus's prompts with their buttons below the fold; UI
 * automation (and a finger) could not reach them. The desktop dialog keeps its buttons under
 * the rows, hugging and right-aligned.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ExtensionPromptDialog } = await import('../ExtensionPromptDialog')
const { uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')

let root: Root | null = null
let host: HTMLElement | null = null

function render(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(createElement(ExtensionPromptDialog)))
}

const WARNINGS = [
  'Read and change all your data on all websites',
  'Read your browsing history',
  'Manage your downloads',
  'Display notifications',
  'Read and modify data you copy and paste',
  'Communicate with cooperating native applications',
  'Manage your apps, extensions and themes',
  'Access your tabs and browsing activity',
  'Change your privacy-related settings',
  'Block content on any page',
  'Read and change your bookmarks',
  'Access the page debugger backend'
]

function prompt(warnings: string[] = WARNINGS): ExtensionPromptRequest {
  return {
    requestId: 'r1',
    kind: 'install',
    name: 'Todoist for Chrome',
    icon: null,
    warnings,
    source: 'chrome-web-store'
  }
}

const initialViewport = viewportStore.get()

beforeEach(() => {
  uiStore.set(() => ({ extensionPrompts: [] }))
  // happy-dom lays nothing out: the layer is 800 tall and the sheet's content 300, as bottomSheet.test has it.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  viewportStore.set(initialViewport)
  uiStore.set(() => ({ extensionPrompts: [] }))
  invoke.mockClear()
})

const phone = (): void =>
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
const desktop = (): void =>
  viewportStore.set({ ...viewportStore.get(), coarse: false, hover: true, formFactor: 'desktop' })

describe('the extension prompt on a phone', () => {
  it('puts its buttons in the sheet footer, outside the scroller, with every warning row inside it', () => {
    phone()
    uiStore.set(() => ({ extensionPrompts: [prompt()] }))
    render()
    const sheet = document.querySelector<HTMLElement>('.zen-sheet')
    expect(sheet).not.toBeNull()
    expect(sheet?.classList.contains('zen-ext-prompt-sheet')).toBe(true)

    const scroller = sheet?.querySelector<HTMLElement>('.zen-sheet-scroll')
    const footer = sheet?.querySelector<HTMLElement>('.zen-sheet-footer')
    expect(scroller).not.toBeNull()
    expect(footer).not.toBeNull()
    // The footer is the scroller's sibling under the sheet, never its descendant.
    expect(footer?.parentElement).toBe(sheet)
    expect(scroller?.contains(footer!)).toBe(false)

    const accept = sheet?.querySelector<HTMLButtonElement>('[data-accept]')
    expect(accept?.textContent).toBe('Add extension')
    expect(accept?.parentElement).toBe(footer)
    const buttons = [...footer!.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Add extension'])
    expect(footer!.children.length).toBe(2)

    // All twelve rows are in the body; none is in the footer, and no button is in the body.
    const rows = [...scroller!.querySelectorAll<HTMLElement>('.zen-v2-row')]
    expect(rows.map((r) => r.querySelector('.zen-v2-label')?.textContent)).toEqual(WARNINGS)
    expect(scroller!.querySelector('button')).toBeNull()
    expect(scroller!.querySelector('.zen-ext-dialog-buttons')).toBeNull()
    expect(scroller!.querySelector('.zen-v2-title-block-title')?.textContent).toContain(
      'Todoist for Chrome'
    )
  })

  it('a prompt with no warnings still has its one row in the body and both buttons in the footer', () => {
    phone()
    uiStore.set(() => ({ extensionPrompts: [{ ...prompt([]), kind: 'request' }] }))
    render()
    const sheet = document.querySelector<HTMLElement>('.zen-sheet')!
    const body = sheet.querySelector('.zen-sheet-scroll')!
    expect(body.querySelectorAll('.zen-v2-row').length).toBe(1)
    expect(body.textContent).toContain('No new permissions are needed')
    const footer = sheet.querySelector('.zen-sheet-footer')!
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Allow'
    ])
  })

  it('the footer button answers the prompt once the sheet has slid away, and only once', async () => {
    const frames = new Frames()
    frames.install()
    phone()
    uiStore.set(() => ({ extensionPrompts: [prompt()] }))
    render()
    // The sheet comes up once the page's cover resolves, then springs in.
    await act(async () => {
      await Promise.resolve()
    })
    act(() => frames.run(60))

    const accept = document.querySelector<HTMLButtonElement>('.zen-sheet-footer [data-accept]')!
    act(() => {
      accept.click()
    })
    // Pressed again while sliding away: the guard keeps it to one answer.
    act(() => {
      accept.click()
    })
    act(() => frames.run(60))
    const answers = invoke.mock.calls.filter(([name]) => name === 'extension.confirmInstall')
    expect(answers).toEqual([['extension.confirmInstall', { requestId: 'r1', accept: true }]])
    expect(uiStore.get().extensionPrompts).toEqual([])
    vi.unstubAllGlobals()
  })
})

/** A hand-cranked animation frame, as bottomSheet.test has it: `run(n)` advances 16 ms a frame. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

describe('the extension prompt on a desktop', () => {
  it('keeps the buttons under the rows in the dialog itself, right-aligned', () => {
    desktop()
    uiStore.set(() => ({ extensionPrompts: [prompt()] }))
    render()
    expect(document.querySelector('.zen-sheet')).toBeNull()
    const dialog = document.querySelector<HTMLElement>('.zen-ext-dialog')!
    const buttons = dialog.querySelector<HTMLElement>('.zen-ext-dialog-buttons')!
    expect(buttons.parentElement).toBe(dialog)
    expect([...buttons.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Add extension'
    ])
    expect(dialog.querySelectorAll('.zen-ext-dialog-body .zen-v2-row').length).toBe(WARNINGS.length)
  })
})
