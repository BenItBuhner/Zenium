import { describe, expect, it, vi } from 'vitest'
import { ShareService, shareClipboardText, shareMailto } from '../share'
import type { Browser } from '../browser'
import type { PageHostMessage, ShareSheetHost } from '../platform'
import type { ZenWindow } from '../window'
import type { Tab } from '../../shared/types'
import type { ShareFile } from '../../shared/share'

const FILE: ShareFile = { name: 'photo.png', type: 'image/png', size: 3, data: 'AAAA' }

interface Harness {
  service: ShareService
  browser: Browser
  win: ZenWindow
  posted: PageHostMessage[]
  copied: Array<{ text: string; toast: string }>
  opened: string[]
  toasts: string[]
  saved: ShareFile[][]
  system: Array<{ url: string; files: number }>
  downloads: string[]
}

function harness(options: { host?: 'none' | 'files' | 'system' } = {}): Harness {
  const posted: PageHostMessage[] = []
  const copied: Harness['copied'] = []
  const opened: string[] = []
  const toasts: string[] = []
  const saved: ShareFile[][] = []
  const system: Harness['system'] = []
  const downloads: string[] = []
  const win = { id: 'w1' } as ZenWindow
  const tab = { id: 't1', url: 'https://news.example/story', title: 'Story' } as Tab
  const kind = options.host ?? 'system'
  const host: ShareSheetHost | undefined =
    kind === 'none'
      ? undefined
      : {
          saveFiles: async (files) => {
            saved.push(files)
            return files.map((f) => `/downloads/${f.name}`)
          },
          ...(kind === 'system'
            ? {
                system: async (payload: { url: string; files: ShareFile[] }) => {
                  system.push({ url: payload.url, files: payload.files.length })
                }
              }
            : {})
        }
  const browser = {
    platform: {
      shareSheet: host,
      shell: { openExternal: (url: string) => opened.push(url) }
    },
    state: { commitVolatile: vi.fn() },
    tabs: {
      tab: (id: string) => (id === 't1' ? tab : undefined),
      view: (id: string) =>
        id === 't1'
          ? {
              postToPage: (m: PageHostMessage) => posted.push(m),
              downloadURL: (url: string) => downloads.push(url)
            }
          : undefined,
      windowFor: () => win
    },
    allWindows: () => [win],
    focusedWindow: () => win,
    copyText: (text: string, toast: string) => copied.push({ text, toast }),
    toast: (message: string) => toasts.push(message)
  }
  const service = new ShareService(browser as unknown as Browser, { now: () => 1 })
  return {
    service,
    browser: browser as unknown as Browser,
    win,
    posted,
    copied,
    opened,
    toasts,
    saved,
    system,
    downloads
  }
}

const CALL = {
  id: 'c1',
  title: 'A story',
  text: 'Read this',
  url: 'https://news.example/story',
  files: [] as ShareFile[]
}

describe('ShareService', () => {
  it('turns a page call into a sheet request for its window and settles the page on the answer', async () => {
    const h = harness()
    h.service.handleMessage('t1', CALL)
    const [request] = h.service.listFor(h.win)
    expect(request).toMatchObject({
      tabId: 't1',
      windowId: 'w1',
      origin: 'news.example',
      title: 'A story',
      text: 'Read this',
      url: 'https://news.example/story',
      files: [],
      system: true
    })
    await h.service.respond(request.id, 'copy')
    expect(h.copied).toEqual([{ text: 'https://news.example/story', toast: 'Link copied' }])
    expect(h.posted).toEqual([{ type: 'share', id: 'c1', result: 'shared' }])
    expect(h.service.listFor(h.win)).toEqual([])
  })

  it('ignores malformed calls and calls from tabs that are not open', () => {
    const h = harness()
    h.service.handleMessage('t1', { id: 1, title: 'x' })
    h.service.handleMessage('t2', CALL)
    expect(h.service.listFor(h.win)).toEqual([])
  })

  it('rejects the page on dismiss, on navigation and when a newer call replaces it', async () => {
    const h = harness()
    h.service.handleMessage('t1', CALL)
    await h.service.respond(h.service.listFor(h.win)[0].id, 'dismiss')
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c1', result: 'aborted' })

    h.service.handleMessage('t1', { ...CALL, id: 'c2' })
    h.service.handleMessage('t1', { ...CALL, id: 'c3' })
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c2', result: 'aborted' })
    expect(h.service.listFor(h.win)).toHaveLength(1)
    h.service.cancelForTab('t1')
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c3', result: 'aborted' })
    expect(h.service.listFor(h.win)).toEqual([])
  })

  it('emails through a mailto and hands the payload to the OS sheet', async () => {
    const h = harness()
    h.service.handleMessage('t1', { ...CALL, files: [FILE] })
    const [request] = h.service.listFor(h.win)
    expect(request.files).toEqual([{ name: 'photo.png', type: 'image/png', size: 3 }])
    await h.service.respond(request.id, 'email')
    expect(h.opened[0]).toBe(
      'mailto:?subject=A%20story&body=Read%20this%0Ahttps%3A%2F%2Fnews.example%2Fstory'
    )
    h.service.handleMessage('t1', { ...CALL, id: 'c2', files: [FILE] })
    await h.service.respond(h.service.listFor(h.win)[0].id, 'system')
    expect(h.system).toEqual([{ url: 'https://news.example/story', files: 1 }])
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c2', result: 'shared' })
  })

  it('saves shared files to Downloads and says so; a sheet without files saves the shared image', async () => {
    const h = harness({ host: 'files' })
    h.service.handleMessage('t1', { ...CALL, files: [FILE, { ...FILE, name: 'b.png' }] })
    const [request] = h.service.listFor(h.win)
    expect(request.system).toBe(false)
    await h.service.respond(request.id, 'save')
    expect(h.saved[0].map((f) => f.name)).toEqual(['photo.png', 'b.png'])
    expect(h.toasts).toEqual(['2 files saved to Downloads'])

    const menu = h.service.open(
      {
        tabId: 't1',
        imageUrl: 'https://news.example/pic.jpg',
        url: 'https://news.example/pic.jpg'
      },
      h.win
    )
    await h.service.respond(menu.id, 'save')
    expect(h.downloads).toEqual(['https://news.example/pic.jpg'])
    // A browser share has no page to settle.
    expect(h.posted.filter((m) => m.type === 'share')).toHaveLength(1)
  })

  it('reports a failed target to the user and to the page as a cancelled share', async () => {
    const h = harness({ host: 'none' })
    h.service.handleMessage('t1', { ...CALL, files: [FILE] })
    const [request] = h.service.listFor(h.win)
    expect(request.system).toBe(false)
    await h.service.respond(request.id, 'save')
    expect(h.toasts[0]).toMatch(/^Could not share:/)
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c1', result: 'aborted' })
    // "More…" without an OS sheet is a no-op that ends the share as cancelled.
    h.service.handleMessage('t1', { ...CALL, id: 'c2' })
    await h.service.respond(h.service.listFor(h.win)[0].id, 'system')
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c2', result: 'aborted' })
  })

  it('lists a browser share for its window only', () => {
    const h = harness()
    const other = { id: 'w2' } as ZenWindow
    h.service.open({ url: 'https://a.example/' }, h.win)
    h.service.open({ text: 'hello' }, other)
    expect(h.service.listFor(h.win).map((r) => r.url)).toEqual(['https://a.example/'])
    expect(h.service.listFor(other).map((r) => r.text)).toEqual(['hello'])
    // A menu share is not tied to a page: a tab's navigation leaves it alone.
    h.service.cancelForTab('t1')
    expect(h.service.listFor(h.win)).toHaveLength(1)
  })
})

describe('share helpers', () => {
  it('copies the link first, then the text, then the title', () => {
    expect(shareClipboardText({ title: 't', text: 'x', url: 'https://u/' })).toBe('https://u/')
    expect(shareClipboardText({ title: 't', text: 'x', url: '' })).toBe('x')
    expect(shareClipboardText({ title: 't', text: '', url: '' })).toBe('t')
  })

  it('builds a mailto with subject and body, spaces as %20', () => {
    expect(shareMailto({ title: 'Hi there', text: '', url: 'https://u/' })).toBe(
      'mailto:?subject=Hi%20there&body=https%3A%2F%2Fu%2F'
    )
    expect(shareMailto({ title: '', text: '', url: '' })).toBe('mailto:')
  })
})
