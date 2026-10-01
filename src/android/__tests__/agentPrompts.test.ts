import { describe, expect, it } from 'vitest'
import {
  agentDownloadDestination,
  clientCertificatesOf,
  downloadAsksWhere,
  fileChooserAnswerWire,
  fileChooserPathsNotice,
  fileChooserRequestOf,
  setInputFilesScript,
  uploadPathsRefusal
} from '../agentPrompts'

describe("an agent's file chooser on Android (agentPrompts.ts)", () => {
  it("reads Kotlin's chooser event as the core's request: one file or several, the accept list trimmed, from an input", () => {
    expect(
      fileChooserRequestOf({ requestId: 'fc_1', multiple: true, accept: [' image/*', '', '.pdf '] })
    ).toEqual({
      mode: 'multiple',
      accept: ['image/*', '.pdf'],
      source: 'input'
    })
    // The WebView has no folder mode, and an older APK's event may carry no accept list at all.
    expect(fileChooserRequestOf({ requestId: 'fc_2' })).toEqual({
      mode: 'single',
      accept: [],
      source: 'input'
    })
    expect(fileChooserRequestOf({ requestId: 'fc_3', multiple: false, accept: 'image/*' })).toEqual(
      {
        mode: 'single',
        accept: [],
        source: 'input'
      }
    )
  })

  it("carries the core's answer to Kotlin: files as bytes with a name and type, a cancel, or the user's chooser", () => {
    expect(fileChooserAnswerWire({ kind: 'cancel' })).toEqual({ kind: 'cancel' })
    expect(fileChooserAnswerWire({ kind: 'user' })).toEqual({ kind: 'user' })
    expect(
      fileChooserAnswerWire({
        kind: 'files',
        files: [
          { name: 'b.txt', base64: 'Yg==' },
          { name: 'c.png', mimeType: 'image/png', base64: 'Yw==' }
        ]
      })
    ).toEqual({
      kind: 'files',
      files: [
        { name: 'b.txt', mimeType: null, base64: 'Yg==' },
        { name: 'c.png', mimeType: 'image/png', base64: 'Yw==' }
      ]
    })
  })

  it('refuses an answer naming a path on this device whole – the chooser is cancelled, no path reaches Kotlin – and says why', () => {
    // A path the WebView opened would be read as Zenium itself (its cookies, its preferences,
    // the agent token store) and handed to the page the agent drives: never, from any agent.
    const files = [
      { name: 'b.txt', base64: 'Yg==' },
      { path: '/data/data/app.zen.chromium/app_webview/Default/Cookies' }
    ]
    expect(fileChooserAnswerWire({ kind: 'files', files })).toEqual({ kind: 'cancel' })
    expect(
      fileChooserAnswerWire({ kind: 'files', files: [{ path: '/sdcard/Download/a.pdf' }] })
    ).toEqual({ kind: 'cancel' })
    const refusal = uploadPathsRefusal(files)
    expect(refusal).toContain('/data/data/app.zen.chromium/app_webview/Default/Cookies')
    expect(refusal).toContain('send the file contents instead')
    expect(uploadPathsRefusal([{ name: 'b.txt', base64: 'Yg==' }])).toBeNull()
    // The same sentence `setInputFiles` answers with, so the agent is told one thing.
    expect(JSON.parse(setInputFilesScript('input', files).slice(1, -1))).toEqual({ error: refusal })
    expect(fileChooserPathsNotice('tab_1', refusal!)).toMatch(
      /^Notice: .*tab tab_1.*cancelled: paths cannot be read on this device/
    )
  })

  it('sets the files of a marked input in the page from the bytes the agent sent, and refuses paths page script cannot read', () => {
    const script = setInputFilesScript('[data-zen-upload="u1"]', [
      { name: 'a.txt', mimeType: 'text/plain', base64: 'YQ==' }
    ])
    expect(script).toContain('"[data-zen-upload=\\"u1\\"]"')
    expect(script).toContain('new DataTransfer()')
    expect(script).toContain("removeAttribute('data-zen-upload')")
    expect(script).toContain('{"name":"a.txt","type":"text/plain","base64":"YQ=="}')
    expect(script).toMatch(/^\(\(\) => \{/)
    const refused = setInputFilesScript('input', [
      { path: '/sdcard/a.txt' },
      { name: 'b', base64: 'Yg==' }
    ])
    expect(JSON.parse(refused.slice(1, -1))).toEqual({
      error: expect.stringContaining('/sdcard/a.txt')
    })
  })

  it("tells a file input by its tag and type, not by instanceof: an input in a same-origin frame is that realm's", () => {
    const script = setInputFilesScript('input', [{ name: 'a.txt', base64: 'YQ==' }])
    expect(script).toContain("input.tagName !== 'INPUT' || input.type !== 'file'")
    expect(script).not.toContain('instanceof HTMLInputElement')
  })
})

describe("an agent's client certificate on Android", () => {
  it("reads Kotlin's described certificates as the core's chooser takes them, dropping what it could not describe", () => {
    expect(
      clientCertificatesOf({
        requestId: 'cert_1',
        tabId: 't1',
        host: 'intranet.example',
        certificates: [
          {
            fingerprint: 'sha256/a',
            subject: 'Ada',
            issuer: 'Analytical CA',
            serialNumber: '1f',
            validFrom: 1,
            validTo: 2
          },
          { fingerprint: 'sha256/b', subject: 'Bob' },
          { subject: 'no fingerprint' },
          null,
          'nonsense'
        ]
      })
    ).toEqual([
      {
        fingerprint: 'sha256/a',
        subject: 'Ada',
        issuer: 'Analytical CA',
        serialNumber: '1f',
        validFrom: 1,
        validTo: 2
      },
      {
        fingerprint: 'sha256/b',
        subject: 'Bob',
        issuer: '',
        serialNumber: '',
        validFrom: 0,
        validTo: 0
      }
    ])
    expect(clientCertificatesOf({ requestId: 'cert_2', tabId: 't1', host: 'h' })).toEqual([])
  })
})

describe("an agent's download on Android", () => {
  it("asks the agent only where the host's save dialog would open: the setting, or the menu's Save As…", () => {
    expect(downloadAsksWhere({ askWhereToSave: false }, false)).toBe(false)
    expect(downloadAsksWhere({ askWhereToSave: true }, false)).toBe(true)
    expect(downloadAsksWhere({ askWhereToSave: false }, true)).toBe(true)
  })

  it("places a saved download in the setting's folder or the default under the agent's name, never the dialog; a cancel places nothing", () => {
    expect(agentDownloadDestination({ kind: 'save', filename: 'report.pdf' }, null)).toEqual({
      mode: 'default',
      agent: { filename: 'report.pdf' }
    })
    expect(
      agentDownloadDestination({ kind: 'save', filename: null }, 'content://tree/Downloads')
    ).toEqual({
      mode: 'folder',
      folder: 'content://tree/Downloads',
      agent: { filename: null }
    })
    expect(agentDownloadDestination({ kind: 'cancel' }, 'content://tree/Downloads')).toBeNull()
  })
})
