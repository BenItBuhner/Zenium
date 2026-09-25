import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAVE_PAGE_FORMAT,
  fileExtensionOf,
  isSavePageFormat,
  MHTML_MIME_TYPE,
  SAVE_PAGE_FORMAT_SPECS,
  SAVE_PAGE_FORMATS,
  savePageMimeType,
  savePagePathFor,
  suggestedSavePageName
} from '../savePage'

describe('Save Page As formats (CT-27)', () => {
  it('are Chrome’s dialog’s three, in its order and its words, the complete page the default', () => {
    expect(SAVE_PAGE_FORMATS).toEqual(['complete', 'htmlOnly', 'singleFile'])
    expect(SAVE_PAGE_FORMATS.map((f) => SAVE_PAGE_FORMAT_SPECS[f].label)).toEqual([
      'Webpage, Complete…',
      'Webpage, HTML Only…',
      'Webpage, Single File…'
    ])
    // The dialog's filter is the label less the menu's ellipsis.
    for (const format of SAVE_PAGE_FORMATS)
      expect(`${SAVE_PAGE_FORMAT_SPECS[format].filter}…`).toBe(SAVE_PAGE_FORMAT_SPECS[format].label)
    expect(DEFAULT_SAVE_PAGE_FORMAT).toBe('complete')
    expect(isSavePageFormat('singleFile')).toBe(true)
    expect(isSavePageFormat('MHTML')).toBe(false)
    expect(isSavePageFormat(undefined)).toBe(false)
  })

  it('name the document’s extensions for the two HTML formats and the archive’s for the single file', () => {
    expect(SAVE_PAGE_FORMAT_SPECS.complete.extensions).toEqual(['html', 'htm'])
    expect(SAVE_PAGE_FORMAT_SPECS.htmlOnly.extensions).toEqual(['html', 'htm'])
    expect(SAVE_PAGE_FORMAT_SPECS.singleFile.extensions).toEqual(['mhtml', 'mht'])
    expect(SAVE_PAGE_FORMAT_SPECS.singleFile.mimeType).toBe(MHTML_MIME_TYPE)
    expect(MHTML_MIME_TYPE).toBe('multipart/related')
  })

  it('suggest the title as the file’s name, made safe, cut, in the format’s extension', () => {
    expect(suggestedSavePageName('Example Domain', 'complete')).toBe('Example Domain.html')
    expect(suggestedSavePageName('Example Domain', 'singleFile')).toBe('Example Domain.mhtml')
    expect(suggestedSavePageName('a/b: "c" <d>|e?*', 'htmlOnly')).toBe('a_b_ _c_ _d_e_.html')
    expect(suggestedSavePageName('', 'complete')).toBe('page.html')
    expect(suggestedSavePageName('x'.repeat(200), 'complete')).toBe(`${'x'.repeat(80)}.html`)
  })

  it('complete a name typed without an extension and leave one typed with any', () => {
    // GTK's dialog does not append the filter's extension to a typed name; Chrome's does.
    expect(savePagePathFor('/home/u/Downloads/page', 'singleFile')).toBe(
      '/home/u/Downloads/page.mhtml'
    )
    expect(savePagePathFor('/home/u/Downloads/page', 'complete')).toBe(
      '/home/u/Downloads/page.html'
    )
    expect(savePagePathFor('/home/u/Downloads/page.htm', 'complete')).toBe(
      '/home/u/Downloads/page.htm'
    )
    expect(savePagePathFor('/home/u/Downloads/page.mht', 'singleFile')).toBe(
      '/home/u/Downloads/page.mht'
    )
    // A dot in a folder's name is no extension of the file's.
    expect(savePagePathFor('/home/u/my.pages/report', 'htmlOnly')).toBe(
      '/home/u/my.pages/report.html'
    )
    expect(savePagePathFor('C:\\Users\\u\\Downloads\\page', 'complete')).toBe(
      'C:\\Users\\u\\Downloads\\page.html'
    )
  })

  it('read the saved file’s type from its extension, for the downloads list', () => {
    expect(fileExtensionOf('/a/b/page.MHTML')).toBe('mhtml')
    expect(fileExtensionOf('/a/b/page')).toBe('')
    expect(fileExtensionOf('/a/b.c/page')).toBe('')
    expect(fileExtensionOf('/a/.hidden')).toBe('')
    expect(savePageMimeType('/a/page.mhtml')).toBe('multipart/related')
    expect(savePageMimeType('/a/page.mht')).toBe('multipart/related')
    expect(savePageMimeType('/a/page.html')).toBe('text/html')
    expect(savePageMimeType('content://downloads/12')).toBe('text/html')
  })
})
