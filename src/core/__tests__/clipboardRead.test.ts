import { describe, expect, it } from 'vitest'
import { CLIPBOARD_READ_PERMISSION, ClipboardReadService } from '../clipboardRead'
import { PermissionService } from '../permissions'
import type { Browser } from '../browser'
import type { ClipboardHost, PageHostMessage, PermissionPromptHost, StoreIO } from '../platform'
import {
  PRIVATE_CONTAINER_ID,
  type ClipboardReadItems,
  type PermissionPrompt,
  type Tab
} from '../../shared/types'
import type { ClipboardReadCall } from '../../shared/clipboardRead'

const PAGE = 'https://paste.example/editor'
const call = (id = 'clip-1', kind: ClipboardReadCall['kind'] = 'text'): ClipboardReadCall => ({
  id,
  kind
})
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Harness {
  service: ClipboardReadService
  posted: PageHostMessage[]
  decisions: Array<{ permission: string; url: string; details: unknown }>
  reads: number
  tab: Tab
  allow: { value: boolean }
  /** What the host's clipboard holds; a function to script a failing read. */
  clip: { text: string | (() => Promise<string>) }
  /** How many times the host's `readItems` (text and image) was asked. */
  itemReads: number
  isPrivate: { value: boolean }
  destroyed: { value: boolean }
  /** Holds the permission decision open until released, like a prompt on screen. */
  hold: { value: Promise<void> | null }
}

/** The host's `readItems` answer, or a function to script a failing one. */
type ScriptedItems = ClipboardReadItems | (() => Promise<ClipboardReadItems>)

function harness(options: { readText?: false; readItems?: ScriptedItems } = {}): Harness {
  const posted: PageHostMessage[] = []
  const decisions: Harness['decisions'] = []
  const allow = { value: true }
  const clip: Harness['clip'] = { text: 'from the host' }
  const isPrivate = { value: false }
  const destroyed = { value: false }
  const hold: Harness['hold'] = { value: null }
  const tab = { id: 't1', url: PAGE, title: 'Paste' } as Tab
  const h = {
    reads: 0,
    itemReads: 0
  }
  const page = {
    isDestroyed: () => destroyed.value,
    postToPage: (m: PageHostMessage) => posted.push(m)
  }
  const items = options.readItems
  const clipboard: ClipboardHost = {
    writeText: () => undefined,
    writeImageFromUrl: async () => false
  }
  if (options.readText !== false) {
    clipboard.readText = async () => {
      h.reads++
      return typeof clip.text === 'string' ? clip.text : clip.text()
    }
  }
  if (items) {
    clipboard.readItems = async () => {
      h.itemReads++
      return typeof items === 'function' ? items() : items
    }
  }
  const browser = {
    platform: { clipboard },
    tabs: {
      tab: (id: string) => (id === 't1' ? tab : undefined),
      pageView: (id: string) => (id === 't1' ? page : undefined),
      pageUrl: (id: string) => (id === 't1' ? tab.url : undefined),
      isPrivate: () => isPrivate.value
    },
    permissions: {
      decide: async (permission: string, url: string, details: unknown) => {
        decisions.push({ permission, url, details })
        if (hold.value) await hold.value
        return allow.value
      }
    }
  }
  const service = new ClipboardReadService(browser as unknown as Browser)
  return {
    service,
    posted,
    decisions,
    get reads() {
      return h.reads
    },
    get itemReads() {
      return h.itemReads
    },
    tab,
    allow,
    clip,
    isPrivate,
    destroyed,
    hold
  }
}

/*
 * The core half of MW-38: the page's shim asked, the site's `clipboard-read` permission
 * decides – the same call the desktop's engine request makes (`permissions.decide`) – and the
 * host's clipboard text goes back to the page that asked, or the denial does.
 */
describe('ClipboardReadService', () => {
  it('asks the clipboard-read permission for the page and, allowed, posts the host’s text back', async () => {
    const h = harness()
    h.service.handleMessage('t1', call())
    await flush()
    expect(h.decisions).toEqual([
      { permission: CLIPBOARD_READ_PERMISSION, url: PAGE, details: { tabId: 't1' } }
    ])
    expect(h.reads).toBe(1)
    expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', text: 'from the host' }])
  })

  it('posts the denial without touching the clipboard when the permission refuses', async () => {
    const h = harness()
    h.allow.value = false
    h.service.handleMessage('t1', call('clip-9', 'items'))
    await flush()
    expect(h.reads).toBe(0)
    expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-9', error: 'denied' }])
  })

  it('keeps a private tab’s decision with the private container, as the desktop does', async () => {
    const h = harness()
    h.isPrivate.value = true
    h.service.handleMessage('t1', call())
    await flush()
    expect(h.decisions[0].details).toEqual({
      tabId: 't1',
      privateContainerId: PRIVATE_CONTAINER_ID
    })
  })

  it('answers with an empty string when the host has no clipboard read, or its read fails', async () => {
    const none = harness({ readText: false })
    none.service.handleMessage('t1', call())
    await flush()
    expect(none.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', text: '' }])

    const failing = harness()
    failing.clip.text = () => Promise.reject(new Error('no clip'))
    failing.service.handleMessage('t1', call('clip-2'))
    await flush()
    expect(failing.posted).toEqual([{ type: 'clipboardRead', id: 'clip-2', text: '' }])
  })

  it('reads nothing and answers nothing for a page that left the site while its prompt was up', async () => {
    const h = harness()
    let release: () => void = () => undefined
    h.hold.value = new Promise((resolve) => {
      release = resolve
    })
    h.service.handleMessage('t1', call())
    await flush()
    expect(h.decisions).toHaveLength(1)
    h.tab.url = 'https://elsewhere.example/'
    release()
    await flush()
    expect(h.reads).toBe(0)
    expect(h.posted).toEqual([])
  })

  it('still answers the same site’s next document, and not a destroyed view', async () => {
    const h = harness()
    let release: () => void = () => undefined
    h.hold.value = new Promise((resolve) => {
      release = resolve
    })
    h.service.handleMessage('t1', call())
    await flush()
    h.tab.url = 'https://paste.example/other-page'
    release()
    await flush()
    expect(h.posted).toHaveLength(1)

    const gone = harness()
    gone.destroyed.value = true
    gone.service.handleMessage('t1', call())
    await flush()
    expect(gone.reads).toBe(0)
    expect(gone.posted).toEqual([])
  })

  it('ignores a malformed call and an unknown tab', async () => {
    const h = harness()
    h.service.handleMessage('t1', { id: 1, kind: 'text' })
    h.service.handleMessage('t1', { id: 'clip-1', kind: 'image' })
    h.service.handleMessage('t1', 'clip-1')
    h.service.handleMessage('t2', call())
    await flush()
    expect(h.decisions).toEqual([])
    expect(h.posted).toEqual([])
  })

  /*
   * The clip's image (MW-38, the phone): a `read()` call takes the host's `readItems` – text and
   * a bounded PNG in one read – where the host has it; `readText()` never asks for the image.
   */
  describe('the clip’s image', () => {
    const IMAGE = { png: 'iVBORw0KGgo=', width: 8, height: 8 }

    it('posts the host’s text and image back for read(), from one readItems call', async () => {
      const h = harness({ readItems: { text: 'caption', image: IMAGE } })
      h.service.handleMessage('t1', call('clip-1', 'items'))
      await flush()
      expect(h.itemReads).toBe(1)
      expect(h.reads).toBe(0)
      expect(h.posted).toEqual([
        { type: 'clipboardRead', id: 'clip-1', text: 'caption', image: IMAGE }
      ])
    })

    it('posts no image field for a clip without one', async () => {
      const h = harness({ readItems: { text: 'words alone' } })
      h.service.handleMessage('t1', call('clip-1', 'items'))
      await flush()
      expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', text: 'words alone' }])
      expect('image' in h.posted[0]).toBe(false)
    })

    it('readText() reads the text alone and never asks for the image', async () => {
      const h = harness({ readItems: { text: 'caption', image: IMAGE } })
      h.service.handleMessage('t1', call('clip-1', 'text'))
      await flush()
      expect(h.itemReads).toBe(0)
      expect(h.reads).toBe(1)
      expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', text: 'from the host' }])
    })

    it('hands the text alone where the host has no readItems, or its read fails', async () => {
      const none = harness()
      none.service.handleMessage('t1', call('clip-1', 'items'))
      await flush()
      expect(none.reads).toBe(1)
      expect(none.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', text: 'from the host' }])

      const failing = harness({ readItems: () => Promise.reject(new Error('no image')) })
      failing.service.handleMessage('t1', call('clip-2', 'items'))
      await flush()
      expect(failing.itemReads).toBe(1)
      expect(failing.reads).toBe(1)
      expect(failing.posted).toEqual([
        { type: 'clipboardRead', id: 'clip-2', text: 'from the host' }
      ])
    })

    it('reads nothing for a denied read(), image or not', async () => {
      const h = harness({ readItems: { text: 'caption', image: IMAGE } })
      h.allow.value = false
      h.service.handleMessage('t1', call('clip-1', 'items'))
      await flush()
      expect(h.itemReads).toBe(0)
      expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', error: 'denied' }])
    })
  })
})

function fakeIo(): StoreIO {
  return {
    readSync: () => null,
    write: async () => undefined,
    writeSync: () => undefined
  }
}

/** A prompt host that answers as scripted and counts the questions it was shown. */
function scriptedPrompts(answers: Array<'allow' | 'block' | 'allow-once' | 'dismiss'>): {
  host: PermissionPromptHost
  shown: PermissionPrompt[]
} {
  const shown: PermissionPrompt[] = []
  const host: PermissionPromptHost = {
    show: async (request) => {
      shown.push(request)
      return answers.shift() ?? 'dismiss'
    },
    cancel: () => undefined
  }
  return { host, shown }
}

function withRealPermissions(prompts: PermissionPromptHost): {
  service: ClipboardReadService
  permissions: PermissionService
  posted: PageHostMessage[]
  reads: number
} {
  const posted: PageHostMessage[] = []
  const permissions = new PermissionService(fakeIo(), prompts, () => 1_700_000_000_000)
  const tab = { id: 't1', url: PAGE, title: 'Paste' } as Tab
  const page = { isDestroyed: () => false, postToPage: (m: PageHostMessage) => posted.push(m) }
  const state = { reads: 0 }
  const browser = {
    platform: {
      clipboard: {
        readText: async () => {
          state.reads++
          return 'clip text'
        }
      }
    },
    tabs: {
      tab: (id: string) => (id === 't1' ? tab : undefined),
      pageView: (id: string) => (id === 't1' ? page : undefined),
      pageUrl: (id: string) => (id === 't1' ? tab.url : undefined),
      isPrivate: () => false
    },
    permissions
  }
  return {
    service: new ClipboardReadService(browser as unknown as Browser),
    permissions,
    posted,
    get reads() {
      return state.reads
    }
  }
}

/*
 * The same machinery as the desktop's `clipboard-read` request: the prompt is the catalogue's
 * ("Allow paste.example to read from your clipboard?", Allow once offered), the answer is
 * remembered for the site, and the site card reads it back.
 */
describe('ClipboardReadService with the permission service', () => {
  it('prompts once with the catalogue’s copy, remembers Allow, and reads without asking again', async () => {
    const prompts = scriptedPrompts(['allow'])
    const h = withRealPermissions(prompts.host)
    h.service.handleMessage('t1', call('clip-1'))
    await flush()
    expect(prompts.shown).toHaveLength(1)
    expect(prompts.shown[0]).toMatchObject({
      tabId: 't1',
      origin: 'https://paste.example',
      permission: 'clipboard-read',
      message: 'Allow paste.example to read from your clipboard?',
      allowLabel: 'Allow',
      blockLabel: 'Block',
      allowOnce: true
    })
    expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', text: 'clip text' }])

    h.service.handleMessage('t1', call('clip-2'))
    await flush()
    expect(prompts.shown).toHaveLength(1)
    expect(h.reads).toBe(2)
    expect(h.posted[1]).toEqual({ type: 'clipboardRead', id: 'clip-2', text: 'clip text' })
    expect(h.permissions.check('clipboard-read', PAGE)).toBe(true)
  })

  it('remembers Block: the next read is refused without a prompt and the clipboard untouched', async () => {
    const prompts = scriptedPrompts(['block'])
    const h = withRealPermissions(prompts.host)
    h.service.handleMessage('t1', call('clip-1'))
    await flush()
    expect(h.posted).toEqual([{ type: 'clipboardRead', id: 'clip-1', error: 'denied' }])

    h.service.handleMessage('t1', call('clip-2'))
    await flush()
    expect(prompts.shown).toHaveLength(1)
    expect(h.reads).toBe(0)
    expect(h.posted[1]).toEqual({ type: 'clipboardRead', id: 'clip-2', error: 'denied' })
    expect(h.permissions.check('clipboard-read', PAGE)).toBe(false)
  })

  it('a dismissed prompt refuses this once and asks again next time', async () => {
    const prompts = scriptedPrompts(['dismiss', 'allow'])
    const h = withRealPermissions(prompts.host)
    h.service.handleMessage('t1', call('clip-1'))
    await flush()
    expect(h.posted[0]).toEqual({ type: 'clipboardRead', id: 'clip-1', error: 'denied' })
    h.service.handleMessage('t1', call('clip-2'))
    await flush()
    expect(prompts.shown).toHaveLength(2)
    expect(h.posted[1]).toEqual({ type: 'clipboardRead', id: 'clip-2', text: 'clip text' })
  })
})
