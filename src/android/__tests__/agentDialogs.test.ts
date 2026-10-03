import { describe, expect, it } from 'vitest'
import { pageDialogAnsweredOf } from '../agentDialogs'

describe("an agent's dialog policy on Android: Kotlin's report (agentDialogs.ts)", () => {
  it("reads Kotlin's pageDialogAnswered event as the core's PageDialogAnswered, kind by kind", () => {
    expect(
      pageDialogAnsweredOf({
        kind: 'alert',
        url: 'https://example.com/a',
        message: 'Saved',
        answer: 'accept',
        rule: 'session'
      })
    ).toEqual({
      kind: 'alert',
      url: 'https://example.com/a',
      message: 'Saved',
      answer: 'accept',
      rule: 'session'
    })
    expect(
      pageDialogAnsweredOf({
        kind: 'confirm',
        url: 'https://example.com/b',
        message: 'Delete?',
        answer: 'dismiss',
        rule: 'default'
      })
    ).toEqual({
      kind: 'confirm',
      url: 'https://example.com/b',
      message: 'Delete?',
      answer: 'dismiss',
      rule: 'default'
    })
    // A prompt carries its field's initial text beside the answer; the answer may be text.
    expect(
      pageDialogAnsweredOf({
        kind: 'prompt',
        url: 'https://example.com/c',
        message: 'Name?',
        defaultValue: 'anon',
        answer: { text: 'Zenium' },
        rule: 'tab'
      })
    ).toEqual({
      kind: 'prompt',
      url: 'https://example.com/c',
      message: 'Name?',
      defaultValue: 'anon',
      answer: { text: 'Zenium' },
      rule: 'tab'
    })
    expect(
      pageDialogAnsweredOf({
        kind: 'beforeunload',
        url: 'https://example.com/d',
        message: 'Changes you made may not be saved.',
        answer: 'stay',
        rule: 'tab'
      })
    ).toEqual({
      kind: 'beforeunload',
      url: 'https://example.com/d',
      message: 'Changes you made may not be saved.',
      answer: 'stay',
      rule: 'tab'
    })
  })

  it('caps the message where the core quotes it and keeps defaultValue to prompts', () => {
    const long = 'x'.repeat(700)
    expect(
      pageDialogAnsweredOf({
        kind: 'alert',
        url: 'https://example.com/',
        message: long,
        answer: 'accept',
        rule: 'default'
      })?.message
    ).toBe('x'.repeat(500))
    const confirm = pageDialogAnsweredOf({
      kind: 'confirm',
      url: 'https://example.com/',
      message: 'Sure?',
      defaultValue: 'stray',
      answer: 'accept',
      rule: 'session'
    })
    expect(confirm).not.toBeNull()
    expect(confirm).not.toHaveProperty('defaultValue')
    // The decoder also accepts a prompt report without defaultValue (an older APK's).
    expect(
      pageDialogAnsweredOf({
        kind: 'prompt',
        url: 'https://example.com/',
        message: 'Name?',
        answer: 'dismiss',
        rule: 'default'
      })
    ).toEqual({
      kind: 'prompt',
      url: 'https://example.com/',
      message: 'Name?',
      answer: 'dismiss',
      rule: 'default'
    })
  })

  it('drops a report it cannot read rather than spend the wrong rule', () => {
    const good = {
      kind: 'confirm',
      url: 'https://example.com/',
      message: 'Sure?',
      answer: 'accept',
      rule: 'tab'
    }
    expect(pageDialogAnsweredOf(good)).not.toBeNull()
    expect(pageDialogAnsweredOf(null)).toBeNull()
    expect(pageDialogAnsweredOf('confirm')).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, kind: 'toast' })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, url: 7 })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, message: undefined })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, rule: 'once' })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, answer: 'ok' })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, answer: { text: 3 } })).toBeNull()
    // The answer must fit the kind, as the core keeps its own answers: an alert is only ever
    // OK, a "Leave site?" only left or stayed, text only with a prompt.
    expect(pageDialogAnsweredOf({ ...good, kind: 'alert', answer: 'dismiss' })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, kind: 'beforeunload', answer: 'accept' })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, answer: 'leave' })).toBeNull()
    expect(pageDialogAnsweredOf({ ...good, answer: { text: 'x' } })).toBeNull()
  })
})
