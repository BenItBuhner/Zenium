import { describe, expect, it } from 'vitest'
import { routeShareAction, type HostShareAction, type ShareActionIo } from '../shareAction'
import type { ShareAction } from '@shared/types'

/*
 * SH-02: a tap on Zenium's row in Android 14's share sheet. The row's third action is Long
 * screenshot (the panel's chip below 14) and reaches the chrome's editor, not the core's
 * viewport shot; Copy link and Print stay the core's.
 */

function recorder(): { io: ShareActionIo; core: ShareAction[]; editor: string[] } {
  const core: ShareAction[] = []
  const editor: string[] = []
  return {
    core,
    editor,
    io: {
      core: (action) => {
        core.push(action)
      },
      openLongScreenshot: (tabId) => {
        editor.push(tabId)
      }
    }
  }
}

describe("the share sheet's row (Android 14)", () => {
  it("routes the row's Long screenshot to the chrome's editor over the tab, not to the core", () => {
    const rec = recorder()
    const tap: HostShareAction = {
      kind: 'longScreenshot',
      url: 'https://example.com/',
      tabId: 'tab-1'
    }
    routeShareAction(tap, rec.io)
    expect(rec.editor).toEqual(['tab-1'])
    expect(rec.core).toEqual([])
  })

  it('drops a Long screenshot without a tab: the row carries it only with one', () => {
    const rec = recorder()
    routeShareAction({ kind: 'longScreenshot', url: 'https://example.com/', tabId: null }, rec.io)
    expect(rec.editor).toEqual([])
    expect(rec.core).toEqual([])
  })

  it('hands Copy link and Print to the core as they were', () => {
    const rec = recorder()
    const copy: ShareAction = { kind: 'copy', url: 'https://example.com/', tabId: null }
    const print: ShareAction = { kind: 'print', url: 'https://example.com/', tabId: 'tab-1' }
    routeShareAction(copy, rec.io)
    routeShareAction(print, rec.io)
    expect(rec.core).toEqual([copy, print])
    expect(rec.editor).toEqual([])
  })

  it("names the kind with the word the row's Kotlin sends (Share.KIND_LONG_SCREENSHOT)", () => {
    const tap: HostShareAction = {
      kind: 'longScreenshot',
      url: 'https://example.com/',
      tabId: 'tab-1'
    }
    expect(tap.kind).toBe('longScreenshot')
  })
})
