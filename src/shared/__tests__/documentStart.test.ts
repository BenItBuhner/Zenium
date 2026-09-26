import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_START_CHANNEL,
  DOCUMENT_START_FIELDS,
  documentStartDefaults,
  readDocumentStartAnswer
} from '../documentStart'

describe('the document-start answer as the page preload reads it', () => {
  it('names one channel and the four fields in the order the preload installs them', () => {
    expect(DOCUMENT_START_CHANNEL).toBe('zen:document-start')
    expect(DOCUMENT_START_FIELDS).toEqual(['signals', 'displayMode', 'guards', 'userScripts'])
  })

  it('gives every field a safe default, a fresh record each time', () => {
    const one = documentStartDefaults()
    expect(one).toEqual({
      signals: { gpc: false, dnt: false },
      displayMode: 'browser',
      guards: [],
      userScripts: []
    })
    one.guards.push('sensors')
    one.signals.gpc = true
    expect(documentStartDefaults()).toEqual({
      signals: { gpc: false, dnt: false },
      displayMode: 'browser',
      guards: [],
      userScripts: []
    })
  })

  it('reads the defaults from an ask that brought nothing', () => {
    for (const raw of [undefined, null, 'browser', 7, true])
      expect(readDocumentStartAnswer(raw)).toEqual(documentStartDefaults())
  })

  it('carries every field the main process answered', () => {
    const plan = [{ extensionId: 'abc', incognito: false, worlds: [] }]
    expect(
      readDocumentStartAnswer({
        signals: { gpc: true, dnt: false },
        displayMode: 'standalone',
        guards: ['sensors', 'payment-handler'],
        userScripts: plan
      })
    ).toEqual({
      signals: { gpc: true, dnt: false },
      displayMode: 'standalone',
      guards: ['sensors', 'payment-handler'],
      userScripts: plan
    })
  })

  it('fills the default for a field missing or in the wrong shape and keeps the others', () => {
    expect(readDocumentStartAnswer({ displayMode: 'fullscreen' })).toEqual({
      ...documentStartDefaults(),
      displayMode: 'fullscreen'
    })
    expect(
      readDocumentStartAnswer({
        signals: 'yes',
        displayMode: 'minimal-ui',
        guards: 'sensors',
        userScripts: null
      })
    ).toEqual({ ...documentStartDefaults(), userScripts: null })
    // Signals are booleans or off; the user-script plan is carried as it came (its reader validates).
    expect(readDocumentStartAnswer({ signals: { gpc: 1, dnt: true }, userScripts: 'x' })).toEqual({
      ...documentStartDefaults(),
      signals: { gpc: false, dnt: true },
      userScripts: 'x'
    })
  })
})
