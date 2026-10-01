import { describe, expect, it } from 'vitest'
import { pageDialogAnswerWire, pageDialogRequestOf, USER_DIALOG } from '../agentDialogs'

describe("the shapes of an agent's page dialogs (agentDialogs.ts, OS-40 part B)", () => {
  it("reads Kotlin's pageDialog event as the core's PageDialogRequest", () => {
    expect(
      pageDialogRequestOf({
        dialogId: 'pd_1',
        kind: 'prompt',
        message: 'Name?',
        defaultValue: 'Ada',
        frameUrl: 'https://ads.example.net/f',
        pageUrl: 'https://example.com/p'
      })
    ).toEqual({
      kind: 'prompt',
      message: 'Name?',
      defaultValue: 'Ada',
      frameUrl: 'https://ads.example.net/f',
      pageUrl: 'https://example.com/p'
    })
  })

  it('gives only a prompt a default, and fills what Kotlin left out', () => {
    expect(
      pageDialogRequestOf({
        dialogId: 'pd_2',
        kind: 'confirm',
        message: 'Sure?',
        defaultValue: 'x'
      })
    ).toEqual({ kind: 'confirm', message: 'Sure?', defaultValue: '', frameUrl: '', pageUrl: '' })
    expect(pageDialogRequestOf({ dialogId: 'pd_3', kind: 'alert', message: 7 })).toEqual({
      kind: 'alert',
      message: '',
      defaultValue: '',
      frameUrl: '',
      pageUrl: ''
    })
  })

  it('refuses an event the core cannot be asked about: no id, an unknown kind, a beforeunload', () => {
    expect(pageDialogRequestOf({ dialogId: '', kind: 'alert' })).toBeNull()
    expect(pageDialogRequestOf({ dialogId: 'pd_4', kind: 'beforeunload' })).toBeNull()
    expect(pageDialogRequestOf({ dialogId: 'pd_5' })).toBeNull()
    expect(pageDialogRequestOf({ dialogId: 'pd_6', kind: 7 })).toBeNull()
  })

  it("carries the core's answer to Kotlin: accepted with a prompt's text, or dismissed", () => {
    expect(pageDialogAnswerWire({ accepted: true, value: 'Grace' })).toEqual({
      user: false,
      accepted: true,
      value: 'Grace'
    })
    expect(pageDialogAnswerWire({ accepted: true, value: null })).toEqual({
      user: false,
      accepted: true,
      value: null
    })
    // A dismissal carries no text, whatever the response says.
    expect(pageDialogAnswerWire({ accepted: false, value: 'ignored' })).toEqual({
      user: false,
      accepted: false,
      value: null
    })
    expect(USER_DIALOG).toEqual({ user: true })
  })
})
