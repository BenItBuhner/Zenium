import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_NAME_LIMIT,
  downloadNameKey,
  downloadNameOf,
  rememberDownloadName,
  type DownloadNames
} from '../downloadNames'

function anchor(href: string, download: string | null): Parameters<typeof downloadNameOf>[0] {
  return { href, getAttribute: (name) => (name === 'download' ? download : null) }
}

describe('download names for blob: and data: anchors', () => {
  it('keys long data: URLs by their head and length, like Kotlin does', () => {
    const short = 'blob:https://example.com/3f1a'
    expect(downloadNameKey(short)).toBe(`${short}#${short.length}`)
    const long = `data:application/octet-stream;base64,${'A'.repeat(5000)}`
    const key = downloadNameKey(long)
    expect(key.length).toBe(200 + 1 + String(long.length).length)
    expect(key.endsWith('#5037')).toBe(true)
    // Two data: URLs with the same head but different lengths stay apart.
    expect(downloadNameKey(long + 'B')).not.toBe(key)
  })

  it('remembers the download attribute and forgets the oldest past the limit', () => {
    const names: DownloadNames = {}
    rememberDownloadName(names, 'blob:https://a/1', 'first.txt')
    for (let i = 0; i < DOWNLOAD_NAME_LIMIT; i++)
      rememberDownloadName(names, `blob:https://a/${i + 2}`, `file-${i}.bin`)
    expect(Object.keys(names).length).toBe(DOWNLOAD_NAME_LIMIT)
    expect(names[downloadNameKey('blob:https://a/1')]).toBeUndefined()
    expect(names[downloadNameKey(`blob:https://a/${DOWNLOAD_NAME_LIMIT + 1}`)]).toBe(
      `file-${DOWNLOAD_NAME_LIMIT - 1}.bin`
    )
  })

  it('a later click on the same href moves it to the newest slot', () => {
    const names: DownloadNames = {}
    rememberDownloadName(names, 'blob:https://a/x', 'old.txt')
    rememberDownloadName(names, 'blob:https://a/y', 'other.txt')
    rememberDownloadName(names, 'blob:https://a/x', 'new.txt')
    expect(Object.keys(names)).toEqual([
      downloadNameKey('blob:https://a/y'),
      downloadNameKey('blob:https://a/x')
    ])
    expect(names[downloadNameKey('blob:https://a/x')]).toBe('new.txt')
  })

  it('ignores empty names and hrefs', () => {
    const names: DownloadNames = {}
    rememberDownloadName(names, 'blob:https://a/x', '')
    rememberDownloadName(names, '', 'name.txt')
    expect(names).toEqual({})
  })

  it('reads the attribute only from anchors that carry one', () => {
    expect(downloadNameOf(anchor('blob:https://a/1', 'report.pdf'))).toEqual({
      href: 'blob:https://a/1',
      name: 'report.pdf'
    })
    // `<a download>` without a value: the server or URL names the file.
    expect(downloadNameOf(anchor('https://a/file.zip', ''))).toEqual({
      href: 'https://a/file.zip',
      name: ''
    })
    expect(downloadNameOf(anchor('https://a/file.zip', null))).toBeNull()
    expect(downloadNameOf(anchor('', 'x.txt'))).toBeNull()
  })
})
