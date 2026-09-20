import { describe, expect, it } from 'vitest'
import {
  ERROR_CANNOT_ATTACH,
  ERROR_INVALID_TARGET,
  ERROR_RESTRICTED_CHROME_URL,
  ERROR_RESTRICTED_EXTENSION_URL,
  attachRefusal,
  commandErrorMessage,
  normalizeDebuggee,
  protocolVersionRefusal,
  tabIdOfTarget,
  tabTargetId
} from '../api/debugger'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

describe('normalizeDebuggee', () => {
  it('takes exactly one of tabId, extensionId and targetId, plus a sessionId', () => {
    expect(normalizeDebuggee({ tabId: 7 })).toEqual({ tabId: 7 })
    expect(normalizeDebuggee({ tabId: 7, sessionId: 'S1' })).toEqual({ tabId: 7, sessionId: 'S1' })
    expect(normalizeDebuggee({ targetId: 'tab-7' })).toEqual({ targetId: 'tab-7' })
    expect(normalizeDebuggee({ extensionId: OTHER })).toEqual({ extensionId: OTHER })
    expect(() => normalizeDebuggee({})).toThrow(ERROR_INVALID_TARGET)
    expect(() => normalizeDebuggee({ tabId: 7, targetId: 'tab-7' })).toThrow(ERROR_INVALID_TARGET)
  })

  it("rejects the shapes Chrome's binding rejects, with its wording", () => {
    expect(() => normalizeDebuggee(7)).toThrow(TypeError)
    expect(() => normalizeDebuggee(null)).toThrow("Error at parameter 'target'")
    expect(() => normalizeDebuggee({ tabId: -1 })).toThrow(/non-negative integer/)
    expect(() => normalizeDebuggee({ tabId: 1.5 })).toThrow(/non-negative integer/)
    expect(() => normalizeDebuggee({ tabId: '7' })).toThrow(/non-negative integer/)
    expect(() => normalizeDebuggee({ targetId: 7 })).toThrow(/'targetId': Value must be a string/)
    expect(() => normalizeDebuggee({ tabId: 7, sessionId: 1 })).toThrow(/'sessionId'/)
  })
})

describe('attachRefusal', () => {
  it("refuses the browser's own pages and other extensions' pages", () => {
    expect(attachRefusal('chrome://settings/', ID)).toBe(ERROR_RESTRICTED_CHROME_URL)
    expect(attachRefusal('zen://newtab/', ID)).toBe(ERROR_RESTRICTED_CHROME_URL)
    expect(attachRefusal('devtools://devtools/bundled/inspector.html', ID)).toBe(
      ERROR_RESTRICTED_CHROME_URL
    )
    expect(attachRefusal(`chrome-extension://${OTHER}/popup.html`, ID)).toBe(
      ERROR_RESTRICTED_EXTENSION_URL
    )
    expect(attachRefusal('view-source:https://a.example/', ID)).toBe(ERROR_CANNOT_ATTACH)
  })

  it("allows web pages, files, about:blank and the extension's own pages", () => {
    for (const url of [
      'https://a.example/page',
      'http://127.0.0.1:8080/',
      'file:///tmp/a.html',
      'about:blank',
      `chrome-extension://${ID}/page.html`,
      'data:text/html,hi',
      ''
    ]) {
      expect(attachRefusal(url, ID)).toBeNull()
    }
  })
})

describe('protocol versions and ids', () => {
  it('accepts 1.0 to 1.3 and names anything else in the error', () => {
    for (const v of ['1.0', '1.1', '1.2', '1.3']) expect(protocolVersionRefusal(v)).toBeNull()
    expect(protocolVersionRefusal('2.0')).toBe('Requested protocol version is not supported: 2.0.')
    expect(protocolVersionRefusal('')).toBe('Requested protocol version is not supported: .')
  })

  it('round-trips a tab through its target id', () => {
    expect(tabTargetId(12)).toBe('tab-12')
    expect(tabIdOfTarget('tab-12')).toBe(12)
    expect(tabIdOfTarget('E5A1')).toBeNull()
    expect(tabIdOfTarget('tab-x')).toBeNull()
  })

  it("shapes a failed command's lastError as the protocol's error object", () => {
    expect(JSON.parse(commandErrorMessage("'Foo.bar' wasn't found"))).toEqual({
      code: -32000,
      message: "'Foo.bar' wasn't found"
    })
    expect(JSON.parse(commandErrorMessage('nope', -32601))).toEqual({
      code: -32601,
      message: 'nope'
    })
  })
})
