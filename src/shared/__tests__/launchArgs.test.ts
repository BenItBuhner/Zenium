import { describe, expect, it } from 'vitest'
import { launchArgToUrl, parseLaunchArgs, pathToFileUrl } from '../launchArgs'

describe('parseLaunchArgs', () => {
  it('collects web URLs in order and ignores Chromium switches', () => {
    const launch = parseLaunchArgs(
      ['--no-sandbox', 'https://example.org/a?b=c#d', '--original-process-start-time=1', 'http://x.test'],
      '/home/me'
    )
    expect(launch).toEqual({
      urls: ['https://example.org/a?b=c#d', 'http://x.test'],
      window: 'current',
      makeDefault: false
    })
  })

  it('reads the window flags and lets the most specific one win', () => {
    expect(parseLaunchArgs(['--new-window'], '/').window).toBe('new')
    expect(parseLaunchArgs(['--blank-window'], '/').window).toBe('blank')
    expect(parseLaunchArgs(['--private-window'], '/').window).toBe('private')
    expect(parseLaunchArgs(['--incognito'], '/').window).toBe('private')
    expect(parseLaunchArgs(['--private-window', '--new-window'], '/').window).toBe('private')
    expect(parseLaunchArgs(['--New-Window', 'example.org'], '/')).toEqual({
      urls: ['https://example.org'],
      window: 'new',
      makeDefault: false
    })
  })

  it('recognises the Windows ReinstallCommand flag', () => {
    expect(parseLaunchArgs(['--make-default-browser'], 'C:\\').makeDefault).toBe(true)
    expect(parseLaunchArgs(['--hide-icons'], 'C:\\')).toEqual({
      urls: [],
      window: 'current',
      makeDefault: false
    })
  })

  it('turns absolute paths into file URLs, encoding spaces and reserved characters', () => {
    expect(parseLaunchArgs(['/tmp/test.html'], '/').urls).toEqual(['file:///tmp/test.html'])
    expect(parseLaunchArgs(['/tmp/my docs/a#1 (copy).pdf'], '/').urls).toEqual([
      'file:///tmp/my%20docs/a%231%20(copy).pdf'
    ])
  })

  it('handles Windows drive and UNC paths', () => {
    expect(parseLaunchArgs(['C:\\Users\\Me\\My File.html'], 'C:\\Windows').urls).toEqual([
      'file:///C:/Users/Me/My%20File.html'
    ])
    expect(parseLaunchArgs(['d:/docs/index.htm'], 'C:\\').urls).toEqual([
      'file:///D:/docs/index.htm'
    ])
    expect(parseLaunchArgs(['\\\\server\\share\\dir\\page.html'], 'C:\\').urls).toEqual([
      'file://server/share/dir/page.html'
    ])
  })

  it('strips the quotes a "%1" shell command leaves behind', () => {
    expect(parseLaunchArgs(['"C:\\Users\\Me\\a b.html"'], 'C:\\').urls).toEqual([
      'file:///C:/Users/Me/a%20b.html'
    ])
    expect(parseLaunchArgs(['"https://example.org/"'], '/').urls).toEqual(['https://example.org/'])
    expect(parseLaunchArgs(['C:\\x.html"'], 'C:\\').urls).toEqual(['file:///C:/x.html'])
  })

  it('resolves relative document paths against the working directory', () => {
    expect(parseLaunchArgs(['test.html'], '/home/me').urls).toEqual(['file:///home/me/test.html'])
    expect(parseLaunchArgs(['./docs/../a.pdf'], '/home/me/').urls).toEqual([
      'file:///home/me/a.pdf'
    ])
    expect(parseLaunchArgs(['..\\report.PDF'], 'C:\\Users\\Me\\Desktop').urls).toEqual([
      'file:///C:/Users/Me/report.PDF'
    ])
    expect(parseLaunchArgs(['sub\\page.html'], '\\\\nas\\home\\me').urls).toEqual([
      'file://nas/home/me/sub/page.html'
    ])
  })

  it('treats bare hosts as https URLs and drops words and foreign schemes', () => {
    expect(parseLaunchArgs(['example.org', 'zen', 'mailto:a@b.c', 'about:blank'], '/').urls).toEqual([
      'https://example.org'
    ])
    expect(parseLaunchArgs(['zen://settings', 'javascript:alert(1)'], '/').urls).toEqual([])
  })

  it('passes file URLs through untouched', () => {
    expect(launchArgToUrl('file:///tmp/a%20b.html', '/')).toBe('file:///tmp/a%20b.html')
  })
})

describe('pathToFileUrl', () => {
  it('produces three slashes for POSIX and drive paths and a host for UNC shares', () => {
    expect(pathToFileUrl('/usr/share/doc/index.html')).toBe('file:///usr/share/doc/index.html')
    expect(pathToFileUrl('c:\\a\\b.html')).toBe('file:///C:/a/b.html')
    expect(pathToFileUrl('\\\\srv\\share')).toBe('file://srv/share')
    expect(pathToFileUrl('/tmp/100%.html')).toBe('file:///tmp/100%25.html')
  })
})
