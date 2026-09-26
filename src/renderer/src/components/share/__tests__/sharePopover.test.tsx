// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ShareRequest, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { closeAllPopovers } from '@renderer/lib/portals'
import { qrSymbol } from '@renderer/lib/qr'
import { sharePreview, sharedImage, shareTargets } from '@renderer/lib/share'
import { uiStore } from '@renderer/lib/ui'
import { ShareLayer } from '../SharePopover'

/*
 * The desktop's share popover (share/SharePopover.tsx, MW-21): the share surface of a host with
 * a share sheet – registered through `ui.surface` there and never elsewhere – showing, for the
 * oldest request of the window, what is shared, the link's QR code, and the targets as rows in
 * Chrome's order (Copy link / Copy text, Email, Save for files or an image, More… for the OS's
 * sheet on macOS); a row answers the request once, Escape and an outside press dismiss it. It
 * overhangs the content frame, so it paints once the page's view has given way to its picture.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REQUEST: ShareRequest = {
  id: 'share-1',
  tabId: 't1',
  windowId: 'w1',
  origin: 'news.example',
  title: 'A story',
  text: 'Read this',
  url: 'https://news.example/story',
  files: [],
  imageUrl: null,
  system: false,
  requestedAt: 1
}

function stateWith(requests: ShareRequest[], shareSheet = true): UIState {
  return {
    platform: 'linux',
    capabilities: { shareSheet, windows: true },
    tabs: { t1: { id: 't1', url: 'https://news.example/story' } },
    spaces: [{ id: 'space', activeTabId: 't1' }],
    activeSpaceId: 'space',
    shareRequests: requests
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-share-popover]')
}

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The page's capture lands and the popover takes its first paint. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  vi.mocked(run).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('shareTargets', () => {
  it('offers Copy link and Email for a link, Save for files or an image, More… for the OS sheet', () => {
    expect(shareTargets(REQUEST).map((t) => [t.answer, t.label])).toEqual([
      ['copy', 'Copy link'],
      ['email', 'Email']
    ])
    expect(shareTargets({ ...REQUEST, url: '' })[0].label).toBe('Copy text')
    const files = shareTargets({
      ...REQUEST,
      files: [
        { name: 'a.png', type: 'image/png', size: 1024 },
        { name: 'b.png', type: 'image/png', size: 1024 }
      ]
    })
    expect(files[2]).toMatchObject({
      answer: 'save',
      label: 'Save 2 files',
      description: '2 files · 2.0 KB'
    })
    expect(
      shareTargets({ ...REQUEST, files: [{ name: 'a.png', type: 'image/png', size: 512 }] })[2]
    ).toMatchObject({ label: 'Save file', description: 'a.png · 512 B' })
    expect(shareTargets({ ...REQUEST, imageUrl: 'https://x/i.png' })[2].label).toBe('Save image')
    expect(shareTargets({ ...REQUEST, system: true }).at(-1)).toMatchObject({
      answer: 'system',
      label: 'More…'
    })
  })

  it('a share of one picture and nothing else (a capture’s) offers Copy image and Save file, and no Email with nothing to mail', () => {
    const picture = { name: 'Screenshot 2026-09-26 at 14.05.09.png', type: 'image/png', size: 2048 }
    const capture: ShareRequest = { ...REQUEST, origin: null, url: '', text: '', files: [picture] }
    expect(sharedImage(capture)).toBe(picture)
    expect(shareTargets(capture).map((t) => [t.answer, t.label])).toEqual([
      ['copy', 'Copy image'],
      ['save', 'Save file']
    ])
    expect(shareTargets({ ...capture, system: true }).map((t) => t.answer)).toEqual([
      'copy',
      'save',
      'system'
    ])
    // Words beside the picture, two files, or a file that is not a picture: the copy is of the
    // words and Email is back.
    expect(sharedImage({ ...capture, url: 'https://x/' })).toBeNull()
    expect(sharedImage({ ...capture, text: 'hi' })).toBeNull()
    expect(sharedImage({ ...capture, files: [picture, picture] })).toBeNull()
    expect(sharedImage({ ...capture, files: [{ ...picture, type: 'application/pdf' }] })).toBeNull()
    expect(shareTargets({ ...capture, text: 'hi' }).map((t) => t.label)).toEqual([
      'Copy text',
      'Email',
      'Save file'
    ])
  })
})

describe('sharePreview', () => {
  it('shows the title over the link, else the text, and never the same line twice', () => {
    expect(sharePreview(REQUEST)).toEqual({
      title: 'A story',
      detail: 'https://news.example/story'
    })
    expect(sharePreview({ ...REQUEST, url: '' })).toEqual({ title: 'A story', detail: 'Read this' })
    expect(sharePreview({ ...REQUEST, title: '' })).toEqual({
      title: 'https://news.example/story',
      detail: 'Read this'
    })
    expect(sharePreview({ ...REQUEST, title: '', text: '' })).toEqual({
      title: 'https://news.example/story',
      detail: ''
    })
    expect(sharePreview({ ...REQUEST, title: '', url: '' })).toEqual({
      title: 'Read this',
      detail: ''
    })
  })
})

describe('ShareLayer as the share surface', () => {
  it('registers the share surface on a host with a share sheet only', () => {
    render(<ShareLayer state={stateWith([], false)} />)
    expect(run).not.toHaveBeenCalled()
    act(() => root!.unmount())
    root = null
    render(<ShareLayer state={stateWith([])} />)
    expect(vi.mocked(run).mock.calls).toEqual([['ui.surface', { surface: 'share', mounted: true }]])
    expect(popover()).toBeNull()
  })

  it('shows the oldest request: its title block, preview, QR code and rows in order, once the page has given way', async () => {
    render(
      <ShareLayer
        state={stateWith([REQUEST, { ...REQUEST, id: 'share-2', title: 'Later', requestedAt: 2 }])}
      />
    )
    // Not before the page's picture is in place: the popover overhangs the content frame.
    expect(popover()).toBeNull()
    await settle()
    expect(uiStore.get().floatingChrome).toBe(1)
    const panel = popover()!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.style.width).toBe('320px')
    expect(panel.querySelector('h2')!.textContent).toBe('Share')
    expect(panel.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'news.example wants to share'
    )
    expect(panel.querySelector('.zen-share-preview-title')!.textContent).toBe('A story')
    expect(panel.querySelector('.zen-share-preview-detail')!.textContent).toBe(
      'https://news.example/story'
    )
    const qr = panel.querySelector('[data-share-qr] svg')!
    expect(qr.getAttribute('aria-label')).toBe('QR code for https://news.example/story')
    expect(qr.querySelector('path')!.getAttribute('d')).toMatch(/^M/)
    // The tile is 160 under its hairline, the symbol drawn on the 158 inside it at a whole number
    // of pixels a module (a 26-byte link is a version-2 symbol: 25 + 8 quiet = 33 modules, 4 px
    // each, 13 of the tile's white on either side), never a fraction that crispEdges rounds unevenly.
    expect(qr.getAttribute('width')).toBe('160')
    expect(qr.getAttribute('viewBox')).toBe('0 0 158 158')
    expect(qrSymbol('https://news.example/story')!.size).toBe(33)
    expect(qr.querySelector('g')!.getAttribute('transform')).toBe('translate(13 13) scale(4)')
    expect([...panel.querySelectorAll('[data-share-target]')].map((b) => b.textContent)).toEqual([
      'Copy link',
      'Email'
    ])
    // The first target has the keyboard (§9.22).
    expect(document.activeElement).toBe(panel.querySelector('[data-share-target="copy"]'))
    act(() => root!.unmount())
    root = null
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('titles a share from the menu "Share this page" and draws no QR code without a link', async () => {
    render(<ShareLayer state={stateWith([{ ...REQUEST, origin: null, url: '' }])} />)
    await settle()
    const panel = popover()!
    expect(panel.querySelector('h2')!.textContent).toBe('Share this page')
    expect(panel.querySelector('.zen-v2-title-block-description')).toBeNull()
    expect(panel.querySelector('[data-share-qr]')).toBeNull()
    expect(panel.querySelector('.zen-share-preview-detail')!.textContent).toBe('Read this')
  })

  it('a capture’s share of the picture alone is titled "Share", names the file, and hangs from the control that asked for it (data-share-anchor) ahead of the pill', async () => {
    // The address pill and, over the page, the capture card's Share button.
    const pill = document.createElement('div')
    pill.className = 'zen-pill'
    pill.getBoundingClientRect = () =>
      ({ left: 300, top: 8, width: 600, height: 32, right: 900, bottom: 40 }) as DOMRect
    const share = document.createElement('button')
    share.setAttribute('data-share-anchor', '')
    // Under the window's 60 % cap there is room below the button (happy-dom's 1024 × 768).
    share.getBoundingClientRect = () =>
      ({ left: 200, top: 300, width: 80, height: 32, right: 280, bottom: 332 }) as DOMRect
    document.body.append(pill, share)
    try {
      const picture = { name: 'Screenshot 2026-09-26 at 14.05.09.png', type: 'image/png', size: 3 }
      render(
        <ShareLayer
          state={stateWith([
            { ...REQUEST, origin: null, title: 'Example', text: '', url: '', files: [picture] }
          ])}
        />
      )
      await settle()
      const panel = popover()!
      expect(panel.querySelector('h2')!.textContent).toBe('Share')
      expect(panel.querySelector('.zen-v2-title-block-description')).toBeNull()
      expect(panel.querySelector('[data-share-qr]')).toBeNull()
      expect(panel.textContent).toContain(picture.name)
      expect(
        [...panel.querySelectorAll('[data-share-target] .zen-v2-label')].map((b) => b.textContent)
      ).toEqual(['Copy image', 'Save file'])
      // Under the Share button's bottom edge, start-aligned with it – not under the pill.
      expect(panel.style.top).toBe('332px')
      expect(panel.style.left).toBe('200px')
    } finally {
      pill.remove()
      share.remove()
    }
  })

  it('a row answers the request once; Escape dismisses it', async () => {
    render(<ShareLayer state={stateWith([REQUEST])} />)
    await settle()
    const copy = popover()!.querySelector('[data-share-target="copy"]')
    click(copy)
    click(copy)
    expect(vi.mocked(run).mock.calls.filter(([name]) => name === 'share.respond')).toEqual([
      ['share.respond', { id: 'share-1', answer: 'copy' }]
    ])

    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()
    render(<ShareLayer state={stateWith([REQUEST])} />)
    await settle()
    act(() => {
      popover()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(run).toHaveBeenCalledWith('share.respond', { id: 'share-1', answer: 'dismiss' })
  })
})
