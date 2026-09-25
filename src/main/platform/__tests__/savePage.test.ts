import { describe, expect, it } from 'vitest'
import { ELECTRON_SAVE_TYPES, savePageDialogOptions, savePageTarget } from '../savePage'

describe('Save Page As on Electron (CT-27)', () => {
  it('opens the dialog on the one filter of the format picked, under Chrome’s title, at the suggested name', () => {
    expect(savePageDialogOptions('complete', '/home/u/Downloads/Example.html')).toEqual({
      title: 'Save Page As',
      defaultPath: '/home/u/Downloads/Example.html',
      filters: [{ name: 'Webpage, Complete', extensions: ['html', 'htm'] }]
    })
    expect(savePageDialogOptions('htmlOnly', '/x/Example.html').filters).toEqual([
      { name: 'Webpage, HTML Only', extensions: ['html', 'htm'] }
    ])
    expect(savePageDialogOptions('singleFile', '/x/Example.mhtml').filters).toEqual([
      { name: 'Webpage, Single File', extensions: ['mhtml', 'mht'] }
    ])
  })

  it('writes with webContents.savePage’s type for the format, completing a typed name’s extension', () => {
    expect(ELECTRON_SAVE_TYPES).toEqual({
      complete: 'HTMLComplete',
      htmlOnly: 'HTMLOnly',
      singleFile: 'MHTML'
    })
    expect(savePageTarget('/home/u/Downloads/Example.html', 'complete')).toEqual({
      path: '/home/u/Downloads/Example.html',
      saveType: 'HTMLComplete'
    })
    // GTK's dialog hands back the name as typed, without the filter's extension.
    expect(savePageTarget('/home/u/Downloads/Example', 'singleFile')).toEqual({
      path: '/home/u/Downloads/Example.mhtml',
      saveType: 'MHTML'
    })
    expect(savePageTarget('/home/u/Downloads/Example.htm', 'htmlOnly')).toEqual({
      path: '/home/u/Downloads/Example.htm',
      saveType: 'HTMLOnly'
    })
  })
})
