import { describe, expect, it } from 'vitest'
import {
  fromSource,
  parseStoreInput,
  sourceLabel,
  storePageUrl,
  versionAndSource
} from '../storeInput'

const DARK_READER = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'

describe('parseStoreInput', () => {
  it('accepts a bare 32-letter id and leaves the store to main', () => {
    expect(parseStoreInput(` ${DARK_READER} `)).toEqual({ ref: DARK_READER, id: DARK_READER })
  })

  it('accepts Chrome Web Store URLs in both shapes, with or without a slug', () => {
    expect(
      parseStoreInput(`https://chromewebstore.google.com/detail/dark-reader/${DARK_READER}`)
    ).toEqual({ ref: DARK_READER, id: DARK_READER, store: 'chrome-web-store' })
    expect(parseStoreInput(`https://chromewebstore.google.com/detail/${DARK_READER}`)).toEqual({
      ref: DARK_READER,
      id: DARK_READER,
      store: 'chrome-web-store'
    })
    expect(
      parseStoreInput(`https://chrome.google.com/webstore/detail/dark-reader/${DARK_READER}?hl=en`)
    ).toEqual({ ref: DARK_READER, id: DARK_READER, store: 'chrome-web-store' })
  })

  it('accepts Edge Add-ons URLs and a pasted URL without its scheme', () => {
    const edgeId = 'ifoakfbpdcdoeenechcleahebpibofpc'
    expect(
      parseStoreInput(`https://microsoftedge.microsoft.com/addons/detail/dark-reader/${edgeId}`)
    ).toEqual({ ref: edgeId, id: edgeId, store: 'edge-add-ons' })
    expect(parseStoreInput(`chromewebstore.google.com/detail/dark-reader/${DARK_READER}`)).toEqual({
      ref: DARK_READER,
      id: DARK_READER,
      store: 'chrome-web-store'
    })
  })

  it('rejects anything else', () => {
    expect(parseStoreInput('')).toBeNull()
    expect(parseStoreInput('dark reader')).toBeNull()
    expect(parseStoreInput('https://example.com/detail/x/' + DARK_READER)).toBeNull()
    expect(parseStoreInput('abcdefghijklmnopqrstuvwxyzabcdef')).toBeNull() // letters past p
    expect(parseStoreInput(DARK_READER.slice(0, 31))).toBeNull()
  })
})

describe('labels', () => {
  it('names every source in sentence case', () => {
    expect(sourceLabel('chrome-web-store')).toBe('Chrome Web Store')
    expect(sourceLabel('edge-add-ons')).toBe('Edge Add-ons')
    expect(sourceLabel('crx')).toBe('CRX file')
    expect(sourceLabel('zip')).toBe('ZIP file')
    expect(sourceLabel('unpacked')).toBe('Unpacked')
    expect(sourceLabel(undefined)).toBe('Unpacked')
  })

  it('builds the second line', () => {
    expect(versionAndSource('4.9.132', 'chrome-web-store')).toBe('v4.9.132 · Chrome Web Store')
    expect(versionAndSource('', 'unpacked')).toBe('Unpacked')
  })

  it("writes the dialog's source as prose, not the registry's enum names", () => {
    expect(fromSource('chrome-web-store')).toBe('From the Chrome Web Store')
    expect(fromSource('edge-add-ons')).toBe('From Edge Add-ons')
    expect(fromSource('crx')).toBe('From a CRX file')
    expect(fromSource('zip')).toBe('From a ZIP file')
    expect(fromSource('unpacked')).toBe('From an unpacked folder')
    expect(fromSource(undefined)).toBe('From an unpacked folder')
  })

  it('links to the store page only for store installs with a real id', () => {
    expect(storePageUrl('chrome-web-store', DARK_READER)).toBe(
      `https://chromewebstore.google.com/detail/${DARK_READER}`
    )
    expect(storePageUrl('edge-add-ons', DARK_READER)).toBe(
      `https://microsoftedge.microsoft.com/addons/detail/${DARK_READER}`
    )
    expect(storePageUrl('unpacked', DARK_READER)).toBeNull()
    expect(storePageUrl('chrome-web-store', 'not-an-id')).toBeNull()
  })
})
