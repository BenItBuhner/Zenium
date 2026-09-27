import { describe, expect, it } from 'vitest'
import type { TabViewEvents } from '@core/platform'
import type { Bridge } from '../bridge'
import { AndroidTabView } from '../views'

interface Call {
  method: string
  args: unknown
}

function recordingBridge(): { bridge: Bridge; calls: Call[] } {
  const calls: Call[] = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      calls.push({ method, args })
      return null
    },
    send: (method: string, args: unknown) => {
      calls.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, calls }
}

function viewOn(bridge: Bridge): AndroidTabView {
  const view = new AndroidTabView('tab_1', bridge, undefined)
  view.events = new Proxy({} as TabViewEvents, { get: () => (): undefined => undefined })
  return view
}

describe('AndroidTabView.postURL (CT-32, the image-search upload)', () => {
  it('sends an urlencoded body as `view.post`’s body, for the WebView’s postUrl', () => {
    const { bridge, calls } = recordingBridge()
    viewOn(bridge).postURL(
      'https://www.bing.com/images/detail/search?iss=sbiupload&FORM=CHROMI#enterInsights',
      { encoding: 'urlencoded', fields: [{ name: 'imageBin', value: '/9j/' }] }
    )
    expect(calls).toEqual([
      {
        method: 'view.post',
        args: {
          tabId: 'tab_1',
          url: 'https://www.bing.com/images/detail/search?iss=sbiupload&FORM=CHROMI#enterInsights',
          body: 'imageBin=%2F9j%2F'
        }
      }
    ])
  })

  it('sends a multipart upload as the self-submitting form document (`html`), the WebView having no multipart POST of its own', () => {
    const { bridge, calls } = recordingBridge()
    viewOn(bridge).postURL('https://lens.google.com/v3/upload', {
      encoding: 'multipart',
      fields: [
        {
          name: 'encoded_image',
          file: { base64: '/9j/', contentType: 'image/jpeg' }
        },
        { name: 'image_url', value: 'https://pics.example/a.png' }
      ]
    })
    expect(calls).toHaveLength(1)
    const { method, args } = calls[0]
    const wire = args as { tabId: string; url: string; html?: string; body?: string }
    expect(method).toBe('view.post')
    expect(wire.tabId).toBe('tab_1')
    expect(wire.url).toBe('https://lens.google.com/v3/upload')
    expect(wire.body).toBeUndefined()
    expect(wire.html).toContain(
      '<form id="f" method="post" action="https://lens.google.com/v3/upload" enctype="multipart/form-data"></form>'
    )
    expect(wire.html).toContain('"name":"encoded_image","file":{"base64":"/9j/"')
    // The form's `File` is named by the document from the part's type – the phone's limit: a
    // `<form>` with a file part cannot be scripted without one.
    expect(wire.html).toContain('fname(d.file.contentType)')
    expect(wire.html).toContain('f.submit()')
  })

  it('runs the page script as one expression the host awaits, the way executeJavaScript shapes it', async () => {
    const { bridge, calls } = recordingBridge()
    const { imageFetchScript, LENS_IMAGE_THUMBNAIL } = await import('@shared/imageUpload')
    await viewOn(bridge).executeJavaScript(
      imageFetchScript('https://pics.example/a.png', LENS_IMAGE_THUMBNAIL)
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('view.eval')
    const code = (calls[0].args as { code: string }).code
    // An expression already: not wrapped into a statement function by the view.
    expect(code.startsWith('(async () => {')).toBe(true)
    expect(code).toContain("fetch(src, { credentials, cache: 'force-cache' })")
  })
})

/**
 * The frame-owner protocol's verb (`frame-owner-protocol-interface.md` §6.1 hunk 5): the view
 * sends `view.imageThumbnail` and reads the owner's `ImageFetchResult` back, trusting nothing
 * of its shape.
 */
describe('AndroidTabView.imageThumbnailByOwner (CT-32, the phone’s frame-owner protocol)', () => {
  const THUMB = {
    base64: '/9j/2wBDAAM=',
    contentType: 'image/jpeg',
    width: 1000,
    height: 500,
    originalWidth: 1600,
    originalHeight: 800
  }
  function answeringBridge(reply: unknown | (() => Promise<unknown>)): {
    bridge: Bridge
    calls: Call[]
  } {
    const calls: Call[] = []
    const bridge = {
      call: async (method: string, args: unknown) => {
        calls.push({ method, args })
        return typeof reply === 'function' ? (reply as () => Promise<unknown>)() : reply
      },
      send: () => undefined,
      callSync: () => undefined
    } as unknown as Bridge
    return { bridge, calls }
  }
  const BOUNDS = { maxSide: 1000, minArea: 90000 }

  it('sends the verb in the document’s shape: tabId, src, bounds { maxSide, minArea }, quality, maxBytes', async () => {
    const { bridge, calls } = answeringBridge(JSON.stringify({ ok: true, thumbnail: THUMB }))
    await viewOn(bridge).imageThumbnailByOwner(
      'https://pics.example/a.png',
      BOUNDS,
      0.4,
      20 * 1024 * 1024
    )
    expect(calls).toEqual([
      {
        method: 'view.imageThumbnail',
        args: {
          tabId: 'tab_1',
          src: 'https://pics.example/a.png',
          bounds: { maxSide: 1000, minArea: 90000 },
          quality: 0.4,
          maxBytes: 20 * 1024 * 1024
        }
      }
    ])
  })

  it('reads the owner’s thumbnail from the JSON text the host relays, and from an object a host may hand over parsed', async () => {
    const asText = await viewOn(
      answeringBridge(JSON.stringify({ ok: true, thumbnail: THUMB })).bridge
    ).imageThumbnailByOwner('https://pics.example/a.png', BOUNDS, 0.4, 20 * 1024 * 1024)
    expect(asText).toEqual({ ok: true, thumbnail: THUMB })
    const asObject = await viewOn(
      answeringBridge({ ok: true, thumbnail: THUMB }).bridge
    ).imageThumbnailByOwner('https://pics.example/a.png', BOUNDS, 0.4, 20 * 1024 * 1024)
    expect(asObject).toEqual({ ok: true, thumbnail: THUMB })
  })

  it.each(['opaque', 'gone', 'no-canvas', 'no-owner', 'timeout', 'unsupported', 'too-large'])(
    'passes the typed refusal %s through',
    async (reason) => {
      const result = await viewOn(
        answeringBridge(JSON.stringify({ ok: false, reason })).bridge
      ).imageThumbnailByOwner('https://pics.example/a.png', BOUNDS, 0.4, 20 * 1024 * 1024)
      expect(result).toEqual({ ok: false, reason })
    }
  )

  it('answers null when the host has no such verb (an APK before it rejects the call), so the core keeps today’s path', async () => {
    const result = await viewOn(
      answeringBridge(() => Promise.reject(new Error('Unknown method: view.imageThumbnail'))).bridge
    ).imageThumbnailByOwner('https://pics.example/a.png', BOUNDS, 0.4, 20 * 1024 * 1024)
    expect(result).toBeNull()
    expect(
      await viewOn(answeringBridge(null).bridge).imageThumbnailByOwner(
        'https://pics.example/a.png',
        BOUNDS,
        0.4,
        20 * 1024 * 1024
      )
    ).toBeNull()
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['a reason the core does not know', JSON.stringify({ ok: false, reason: 'stolen' })],
    ['a thumbnail of no shape', JSON.stringify({ ok: true, thumbnail: { base64: 42 } })],
    [
      'a thumbnail past the cap',
      JSON.stringify({ ok: true, thumbnail: { ...THUMB, base64: 'A'.repeat(64) } })
    ]
  ])(
    'reads %s as a decode failure – a refusal, never today’s top-document script on a WebView that has the protocol',
    async (_name, reply) => {
      const result = await viewOn(answeringBridge(reply).bridge).imageThumbnailByOwner(
        'https://pics.example/a.png',
        BOUNDS,
        0.4,
        16
      )
      expect(result).toEqual({ ok: false, reason: 'decode-failed' })
    }
  )
})
