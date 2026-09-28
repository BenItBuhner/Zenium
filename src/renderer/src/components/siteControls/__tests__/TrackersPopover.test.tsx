// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_CONTAINER_ID, type BlockedSite, type Tab } from '@shared/types'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import { closeAllPopovers } from '@renderer/lib/portals'
import { TrackersPopover } from '../TrackersPopover'

/*
 * The tracker report (PS-33): the §9.20 list popover behind the desktop shield's count pill.
 * Rows are §10.1's – the domain as the label, the count as a tabular-nums aside, and the kind of
 * rule on the 13/69% line only for the user's filter, an extension or Safe Browsing (a list match,
 * the default kind, carries no line and is one line tall) – sorted by count as the list opens and
 * never re-sorted while it is up
 * (§9.29); a site the engine meets later joins at the foot. Empty, §9.17's one sentence without
 * a full stop. No controls but the one footer row of §9.20's third form, 32 tall, which leaves
 * for Settings › Privacy and security at the site.
 */

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

const site = (
  domain: string,
  count: number,
  category: BlockedSite['category'] = 'tracker'
): BlockedSite => ({
  domain,
  category,
  count
})

function page(blockedSites?: BlockedSite[]): Tab {
  return {
    id: 't1',
    url: 'https://news.example/story?id=1',
    containerId: DEFAULT_CONTAINER_ID,
    title: 'News',
    favicon: null,
    loading: false,
    blockedCount: blockedSites?.reduce((sum, s) => sum + s.count, 0) ?? 0,
    blockedSites
  } as unknown as Tab
}

function Report({
  tab,
  onDismiss = () => undefined
}: {
  tab: Tab
  onDismiss?: () => void
}): ReactElement {
  return (
    <TrackersPopover
      tab={tab}
      anchor={{ x: 240, y: 8, width: 28, height: 28 }}
      bar={{ x: 20, y: 4, width: 300, height: 32 }}
      closing={false}
      onDismiss={onDismiss}
      onClosed={() => undefined}
    />
  )
}

const dialog = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-testid="tracker-report"]')!

const rows = (): { domain: string; text: string; count: string | null }[] =>
  Array.from(dialog().querySelectorAll<HTMLElement>('[data-tracker-row]')).map((row) => ({
    domain: row.getAttribute('data-tracker-row')!,
    text: row.textContent ?? '',
    count: row.querySelector('[data-count]')?.getAttribute('data-count') ?? null
  }))

beforeEach(() => {
  cmd.mockClear()
  run.mockReset()
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the tracker report popover (PS-33)', () => {
  it('is a 320 dialog titled Trackers blocked, its rows by count with a tabular count – one line for a list match, the rule kind under the others – no controls', () => {
    render(<Report tab={page([site('cdn.example', 1, 'user'), site('ads.example', 4)])} />)
    const el = dialog()
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.style.width).toBe('320px')
    const title = document.getElementById(el.getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe('Trackers blocked')
    expect(rows()).toEqual([
      { domain: 'ads.example', text: 'ads.example4', count: '4' },
      { domain: 'cdn.example', text: 'cdn.exampleYour filter1', count: '1' }
    ])
    // The list match is the default kind and carries no 13 line (the row is §10.1's one line);
    // the user's own filter names itself under the domain.
    const line = (domain: string): Element | null =>
      el.querySelector(`[data-tracker-row="${domain}"] .line-clamp-2`)
    expect(line('ads.example')).toBeNull()
    expect(line('cdn.example')?.textContent).toBe('Your filter')
    for (const aside of el.querySelectorAll<HTMLElement>('[data-count]'))
      expect(aside.classList.contains('tabular-nums')).toBe(true)
    // Rows are facts: no button among them, no per-site allow. The footer row is the one control
    // – the row primitive itself (§9.34: never a utility copy), one line without a control, so
    // the 32 `.zen-v2-row` with its own hover, press and ring – under the hairline, and the
    // focus lands on it as the popover opens (`focus="first"`, the rows being facts).
    expect(el.querySelector('[data-tracker-rows] button')).toBeNull()
    const buttons = Array.from(el.querySelectorAll<HTMLElement>('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Tracking prevention settings…'])
    const footer = buttons[0]!
    expect(footer.classList.contains('zen-v2-row')).toBe(true)
    expect(footer.hasAttribute('data-control')).toBe(false)
    expect(footer.hasAttribute('data-static')).toBe(false)
    expect(footer.querySelector('.line-clamp-2')).toBeNull()
    expect(footer.className).not.toMatch(/\bh-8\b|hover:bg-\[var\(--v2-fill-hover\)\]/)
    expect(footer.closest('[data-footer="navigation"]')).not.toBeNull()
    expect(el.querySelector('[data-footer="navigation"] .h-px')).not.toBeNull()
    expect(document.activeElement).toBe(footer)
  })

  it('draws §9.7’s hairline under the sticky title once the rows have scrolled under it, and drops it at the top again', () => {
    render(<Report tab={page([site('a.example', 1), site('b.example', 3)])} />)
    const el = dialog()
    const title = document.getElementById(el.getAttribute('aria-labelledby')!)!
    const block = title.closest('.p-4')!
    const scroller = el.querySelector<HTMLElement>('[data-tracker-rows]')!
    const hairline = 'shadow-[0_1px_0_0_var(--v2-border)]'
    expect(block.classList.contains(hairline)).toBe(false)
    Object.defineProperty(scroller, 'scrollTop', { value: 12, configurable: true, writable: true })
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(block.classList.contains(hairline)).toBe(true)
    scroller.scrollTop = 0
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(block.classList.contains(hairline)).toBe(false)
  })

  it('holds its order while open: counts move live and a site blocked later joins at the foot', () => {
    const first = page([site('a.example', 1), site('b.example', 3)])
    render(<Report tab={first} />)
    expect(rows().map((r) => r.domain)).toEqual(['b.example', 'a.example'])
    const grown = page([site('a.example', 9), site('b.example', 3), site('c.example', 5)])
    act(() => root!.render(<Report tab={grown} />))
    expect(rows()).toEqual([
      { domain: 'b.example', text: 'b.example3', count: '3' },
      { domain: 'a.example', text: 'a.example9', count: '9' },
      { domain: 'c.example', text: 'c.example5', count: '5' }
    ])
  })

  it('says in one sentence when nothing was blocked, and starts a fresh order when the report empties', () => {
    render(<Report tab={page()} />)
    expect(rows()).toEqual([])
    const empty = dialog().querySelector<HTMLElement>('[data-tracker-rows]')!
    expect(empty.textContent).toBe('No trackers blocked on this page')
    expect(dialog().querySelector('button')?.textContent).toBe('Tracking prevention settings…')
    act(() => root!.render(<Report tab={page([site('x.example', 2), site('y.example', 5)])} />))
    expect(rows().map((r) => r.domain)).toEqual(['y.example', 'x.example'])
    // The document changed under the open list: the record is gone, and the next one sorts anew.
    act(() => root!.render(<Report tab={page()} />))
    expect(rows()).toEqual([])
    act(() => root!.render(<Report tab={page([site('x.example', 7), site('y.example', 5)])} />))
    expect(rows().map((r) => r.domain)).toEqual(['x.example', 'y.example'])
  })

  it('leaves for Settings › Privacy and security at the site from the footer row', () => {
    const onDismiss = vi.fn()
    render(<Report tab={page([site('ads.example', 4)])} onDismiss={onDismiss} />)
    const row = dialog().querySelector<HTMLElement>('[data-footer="navigation"] button')!
    act(() => row.click())
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('page.open', {
      id: 'settings',
      section: 'privacy',
      query: { site: 'https://news.example' }
    })
  })
})
