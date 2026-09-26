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
