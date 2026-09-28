// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The Management page tab (`zen://management`, TB-13; Chrome's chrome://management, from the
 * app menu's Managed Browser row): the title block – "Management" with Chrome's subtitle under
 * it, the organisation named when the bundle names it – the notice that says what Zenium does
 * with the configuration, and the bundle's keys as one group of static rows counted in its
 * aside; for an unmanaged browser the not-managed subtitle and notice and no list. The status
 * is the core's `managed.status`, asked once on mount.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let status: unknown = { by: null, keys: [] }
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'managed.status' ? status : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { ManagementPage } = await import('../ManagementPage')

let root: Root | null = null
let mount: HTMLElement | null = null

/** Mounts the page and lets the status land (one microtask past the command's answer). */
async function mountPage(reply: unknown): Promise<HTMLElement> {
  status = reply
  invoke.mockClear()
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(ManagementPage)))
  await act(async () => {
    await Promise.resolve()
  })
  return mount
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function keys(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-testid="management-key"] .zen-page-row-label')].map(text)
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('ManagementPage', () => {
  it('asks the core once for the status and names the organisation the bundle names, over the notice and the keys, counted, as static rows', async () => {
    const el = await mountPage({
      by: 'Example Corp',
      keys: ['URLBlocklist', 'HomepageLocation', 'EnterpriseCustomLabel']
    })
    expect(invoke.mock.calls.filter((c) => c[0] === 'managed.status')).toHaveLength(1)
    expect(text(el.querySelector('h1.zen-page-title'))).toBe('Management')
    expect(text(el.querySelector('.zen-page-title-desc'))).toBe(
      'Your browser is managed by Example Corp'
    )
    const notice = text(el.querySelector('[data-testid="management-notice"]'))
    expect(notice).toContain(
      'Zenium reads it and lists the settings below; it does not apply them yet.'
    )
    expect(notice).toContain('Activity on this device may also be managed outside of Zenium.')
    const group = el.querySelector<HTMLElement>('[data-testid="management-keys"]')!
    expect(text(group.querySelector('h2'))).toBe('Settings your administrator controls')
    expect(text(group.querySelector('.zen-page-heading-aside'))).toBe('3')
    // The keys sorted, each a static row (§9.34): text, not a target.
    expect(keys(el)).toEqual(['EnterpriseCustomLabel', 'HomepageLocation', 'URLBlocklist'])
    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="management-key"]')]
    expect(rows.every((row) => row.hasAttribute('data-static'))).toBe(true)
    expect(rows.every((row) => row.querySelector('button') === null)).toBe(true)
  })

  it("says the organisation's generic name when the bundle names none: Chrome's subtitle for an unnamed manager", async () => {
    const el = await mountPage({ by: null, keys: ['URLBlocklist'] })
    expect(text(el.querySelector('.zen-page-title-desc'))).toBe(
      'Your browser is managed by your organization'
    )
    expect(keys(el)).toEqual(['URLBlocklist'])
  })

  it("is Chrome's not-managed page for an empty bundle – the subtitle, the notice with the product's name – and lists nothing", async () => {
    const el = await mountPage({ by: null, keys: [] })
    expect(text(el.querySelector('.zen-page-title-desc'))).toBe('Your browser is not managed')
    expect(text(el.querySelector('[data-testid="management-notice"]'))).toBe(
      'This browser is not managed by a company or other organization. Activity on this device may be managed outside of Zenium.'
    )
    expect(el.querySelector('[data-testid="management-keys"]')).toBeNull()
  })

  it('reads a reply that is not a status as unmanaged', async () => {
    const el = await mountPage('nonsense')
    expect(text(el.querySelector('.zen-page-title-desc'))).toBe('Your browser is not managed')
    expect(el.querySelector('[data-testid="management-keys"]')).toBeNull()
  })

  it('draws the title alone until the reply lands: no subtitle, no notice, no list', async () => {
    const el = await mountPage(new Promise(() => undefined))
    expect(text(el.querySelector('h1.zen-page-title'))).toBe('Management')
    expect(el.querySelector('.zen-page-title-desc')).toBeNull()
    expect(el.querySelector('[data-testid="management-notice"]')).toBeNull()
    expect(el.querySelector('[data-testid="management-keys"]')).toBeNull()
  })
})
