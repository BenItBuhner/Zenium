import { describe, expect, it } from 'vitest'
import { imagePostLoadOptions, imageResourceFrames } from '../imagePost'

describe('the image upload on the desktop (CT-32)', () => {
  it('hands loadURL the multipart body as one raw-data element and its content type with the boundary as the header', () => {
    const options = imagePostLoadOptions(
      {
        encoding: 'multipart',
        fields: [
          {
            name: 'encoded_image',
            file: { base64: '/9j/', contentType: 'image/jpeg' }
          },
          { name: 'image_url', value: 'https://pics.example/a.png' }
        ]
      },
      'ZenBoundary'
    )
    expect(options.extraHeaders).toBe('Content-Type: multipart/form-data; boundary=ZenBoundary')
    expect(options.postData).toHaveLength(1)
    const [data] = options.postData as Electron.UploadRawData[]
    expect(data.type).toBe('rawData')
    expect(Buffer.isBuffer(data.bytes)).toBe(true)
    const text = data.bytes.toString('latin1')
    // The file part named and typed, with no filename: Chrome's part (net::AddMultipartValueForUpload) has none.
    expect(
      text.startsWith(
        '--ZenBoundary\r\nContent-Disposition: form-data; name="encoded_image"\r\nContent-Type: image/jpeg\r\n\r\n\u00ff\u00d8\u00ff\r\n'
      )
    ).toBe(true)
    expect(text).not.toContain('filename')
    expect(text.endsWith('--ZenBoundary--\r\n')).toBe(true)
    expect(text).toContain('name="image_url"\r\n\r\nhttps://pics.example/a.png\r\n')
  })

  it('hands loadURL an urlencoded body with its content type', () => {
    const options = imagePostLoadOptions({
      encoding: 'urlencoded',
      fields: [{ name: 'imageBin', value: '/9j/' }]
    })
    expect(options.extraHeaders).toBe('Content-Type: application/x-www-form-urlencoded')
    expect((options.postData as Electron.UploadRawData[])[0].bytes.toString()).toBe(
      'imageBin=%2F9j%2F'
    )
  })

  it('finds the frames whose resource lists carry the image, outermost first, with the listed type and size', () => {
    const tree = {
      frame: { id: 'main' },
      resources: [{ url: 'https://a.example/x.png', mimeType: 'image/png', contentSize: 31601 }],
      childFrames: [
        {
          frame: { id: 'child' },
          resources: [
            { url: 'https://a.example/other.png', mimeType: 'image/png' },
            { url: 'https://a.example/x.png', mimeType: 'image/webp', contentSize: Number.NaN }
          ],
          childFrames: [
            { frame: { id: 'grandchild' }, resources: [{ url: 'https://a.example/x.png' }] }
          ]
        },
        { frame: { id: 'empty' } }
      ]
    }
    expect(imageResourceFrames(tree, 'https://a.example/x.png')).toEqual([
      { frameId: 'main', mimeType: 'image/png', contentSize: 31601 },
      { frameId: 'child', mimeType: 'image/webp', contentSize: null },
      { frameId: 'grandchild', mimeType: '', contentSize: null }
    ])
    expect(imageResourceFrames(tree, 'https://a.example/none.png')).toEqual([])
  })
})
