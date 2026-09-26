import { describe, expect, it, vi } from 'vitest'
import { ShareService, shareClipboardText, shareImage, shareMailto } from '../share'
import type { Browser } from '../browser'
import type { PageHostMessage, ShareSheetHost } from '../platform'
import type { ZenWindow } from '../window'
import type { Tab } from '../../shared/types'
import type { ShareFile, ShareOutcome } from '../../shared/share'
import type { SharePayload } from '../../shared/types'

const FILE: ShareFile = { name: 'photo.png', type: 'image/png', size: 3, data: 'AAAA' }

interface Harness {
  service: ShareService
  browser: Browser
  win: ZenWindow
  posted: PageHostMessage[]
  copied: Array<{ text: string; toast: string }>
  /** Pictures put on the clipboard (`writeImageFromUrl`), as data URLs. */
  images: string[]
  opened: string[]
  toasts: string[]
  saved: ShareFile[][]
  /** Finished downloads the sheet listed for saved files (capture-22). */
  listed: Array<{ path: string; mimeType: string; size?: number; private?: boolean }>
  system: Array<{ url: string; files: number }>
  downloads: string[]
  /** The OS sheet's calls (`shell.share`, Android) and the settlers of their pending answers. */
  shell: SharePayload[]
  settle: Array<(outcome: ShareOutcome | Error) => void>
}

function harness(
  options: {
    host?: 'none' | 'files' | 'system'
    sheet?: boolean
    osSheet?: boolean
    /** The clipboard refuses the picture. */
    clipboardFails?: boolean
    platform?: 'desktop' | 'android'
  } = {}
): Harness {
  const posted: PageHostMessage[] = []
  const copied: Harness['copied'] = []
  const images: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  const saved: ShareFile[][] = []
  const listed: Harness['listed'] = []
  const system: Harness['system'] = []
  const downloads: string[] = []
  const shell: SharePayload[] = []
  const settle: Harness['settle'] = []
  // The window's chrome has the share sheet up unless a test says otherwise (`ui.surface`).
  const win = {
    id: 'w1',
    isPrivate: false,
    surfaces: new Set(options.sheet === false ? [] : ['share'])
  } as unknown as ZenWindow
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
      clipboard: {
        writeImageFromUrl: async (url: string) => {
          if (options.clipboardFails) return false
          images.push(url)
          return true
        }
      },
      shell: {
        openExternal: (url: string) => opened.push(url),
        ...(options.osSheet
          ? {
              share: (payload: SharePayload) => {
                shell.push(payload)
                return new Promise<ShareOutcome | void>((resolve, reject) => {
                  settle.push((outcome) =>
                    outcome instanceof Error ? reject(outcome) : resolve(outcome)
                  )
                })
              }
            }
          : {})
      }
    },
    state: {
      commitVolatile: vi.fn(),
      platform: options.platform ?? 'desktop',
      capabilities: { share: options.osSheet === true, toast: true }
    },
    downloads: {
      addCompleted: (
        path: string,
        mimeType: string,
        fields: { size?: number; private?: boolean } = {}
      ) => listed.push({ path, mimeType, size: fields.size, private: fields.private })
    },
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
    images,
    opened,
    toasts,
    saved,
    listed,
    system,
    downloads,
    shell,
    settle
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
    h.service.handleMessage('t1', { ...CALL, files: [FILE, { ...FILE, name: 'b.png', size: 7 }] })
    const [request] = h.service.listFor(h.win)
    expect(request.system).toBe(false)
    await h.service.respond(request.id, 'save')
    expect(h.saved[0].map((f) => f.name)).toEqual(['photo.png', 'b.png'])
    expect(h.toasts).toEqual(['2 files saved to Downloads'])
    // Each written file is a finished download with its size, so the bubble lists it with
    // Show in folder (capture-22) and the Downloads page does not read it as empty (BUG-031).
    expect(h.listed).toEqual([
      { path: '/downloads/photo.png', mimeType: 'image/png', size: 3, private: false },
      { path: '/downloads/b.png', mimeType: 'image/png', size: 7, private: false }
    ])

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

  it('copies one shared picture as an image, and a share with words beside it as words', async () => {
    const h = harness({ host: 'files' })
    // The browser's own share of a picture alone (a capture's Share): Copy is Copy image.
    const capture = h.service.open(
      { title: 'Story', tabId: 't1', files: [{ ...FILE, name: 'Screenshot.png' }] },
      h.win
    )
    expect(capture.files).toEqual([{ name: 'Screenshot.png', type: 'image/png', size: 3 }])
    await h.service.respond(capture.id, 'copy')
    expect(h.images).toEqual(['data:image/png;base64,AAAA'])
    expect(h.copied).toEqual([])
    // The desktop hears the copy happened: the sheet has left and nothing else says so.
    expect(h.toasts).toEqual(['Image copied'])

    // A page's picture with a link beside it copies the link, as before.
    h.service.handleMessage('t1', { ...CALL, files: [FILE] })
    await h.service.respond(h.service.listFor(h.win)[0].id, 'copy')
    expect(h.copied).toEqual([{ text: 'https://news.example/story', toast: 'Link copied' }])
    expect(h.images).toHaveLength(1)
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c1', result: 'shared' })
  })

  it('reports a picture the clipboard refused; Android 13+ leaves the confirmation to the OS chip', async () => {
    const h = harness({ host: 'files', clipboardFails: true })
    const capture = h.service.open({ files: [FILE] }, h.win)
    await h.service.respond(capture.id, 'copy')
    expect(h.toasts).toEqual(['Could not share: the picture could not be copied'])

    const phone = harness({ host: 'files', platform: 'android' })
    ;(phone.browser.state.capabilities as { clipboardChip?: boolean }).clipboardChip = true
    await phone.service.respond(phone.service.open({ files: [FILE] }, phone.win).id, 'copy')
    expect(phone.images).toHaveLength(1)
    expect(phone.toasts).toEqual([])
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

  it('cancels a page call at once, as a dismissed sheet, while the window has no sheet up', () => {
    const h = harness({ sheet: false })
    h.service.handleMessage('t1', CALL)
    // The page hears Chrome's AbortError right away; nothing is put up to wait on.
    expect(h.posted).toEqual([{ type: 'share', id: 'c1', result: 'aborted' }])
    expect(h.service.listFor(h.win)).toEqual([])
    expect(h.browser.state.commitVolatile).not.toHaveBeenCalled()
    // The sheet mounting (`ui.surface`) lets the next call through to it.
    h.win.surfaces.add('share')
    h.service.handleMessage('t1', { ...CALL, id: 'c2' })
    expect(h.service.listFor(h.win)).toHaveLength(1)
    expect(h.posted).toHaveLength(1)
  })

  it('hands a page call to the OS sheet where the chrome has none and settles on its word', async () => {
    const h = harness({ sheet: false, osSheet: true })
    h.service.handleMessage('t1', { ...CALL, files: [FILE] })
    // Nothing is put up in the chrome; the host shows the OS sheet with the files' bytes.
    expect(h.service.listFor(h.win)).toEqual([])
    expect(h.posted).toEqual([])
    expect(h.shell).toHaveLength(1)
    expect(h.shell[0]).toMatchObject({
      title: 'A story',
      text: 'Read this',
      url: 'https://news.example/story',
      files: [FILE],
      tabId: 't1',
      awaitOutcome: true
    })
    h.settle[0]('shared')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.posted).toEqual([{ type: 'share', id: 'c1', result: 'shared' }])

    // A dismissed sheet, and a host that failed to say, both end as Chrome's AbortError.
    h.service.handleMessage('t1', { ...CALL, id: 'c2' })
    h.settle[1]('aborted')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c2', result: 'aborted' })
    h.service.handleMessage('t1', { ...CALL, id: 'c3' })
    h.settle[2](new Error('no activity'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c3', result: 'aborted' })
  })

  it('aborts a pending OS-sheet share when the tab navigates, and once only', async () => {
    const h = harness({ sheet: false, osSheet: true })
    h.service.handleMessage('t1', CALL)
    h.service.cancelForTab('t1')
    expect(h.posted).toEqual([{ type: 'share', id: 'c1', result: 'aborted' }])
    // The host's late answer finds nothing waiting.
    h.settle[0]('shared')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.posted).toHaveLength(1)
    // A second call while the first is up replaces it (one share at a time).
    h.service.handleMessage('t1', { ...CALL, id: 'c2' })
    h.service.handleMessage('t1', { ...CALL, id: 'c3' })
    expect(h.posted.at(-1)).toEqual({ type: 'share', id: 'c2', result: 'aborted' })
    expect(h.shell).toHaveLength(3)
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

  it('names the one picture a share carries, and nothing else, as the thing to copy', () => {
    const alone = { url: '', text: '' }
    expect(shareImage(alone, [FILE])).toBe(FILE)
    expect(shareImage(alone, [{ ...FILE, type: 'IMAGE/JPEG' }])?.type).toBe('IMAGE/JPEG')
    // Words beside it, two files, a file without bytes or one that is not a picture: no.
    expect(shareImage({ url: 'https://u/', text: '' }, [FILE])).toBeNull()
    expect(shareImage({ url: '', text: 'hi' }, [FILE])).toBeNull()
    expect(shareImage(alone, [FILE, FILE])).toBeNull()
    expect(
      shareImage(alone, [{ name: 'a.png', type: 'image/png', size: 3, uri: 'content://a' }])
    ).toBeNull()
    expect(shareImage(alone, [{ ...FILE, name: 'a.pdf', type: 'application/pdf' }])).toBeNull()
    expect(shareImage(alone, [])).toBeNull()
  })
})
