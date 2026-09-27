import { describe, expect, it } from 'vitest'
import { folderNameOf } from '../paths'

describe('the folder a saved file sits in – what a save toast reports (§9.33)', () => {
  it('is the last segment of the path’s parent, on either separator', () => {
    expect(folderNameOf('/home/b/Downloads/Screenshot 2026-09-23 at 14.05.09.png')).toBe(
      'Downloads'
    )
    expect(folderNameOf('C:\\Users\\b\\Downloads\\Screenshot.png')).toBe('Downloads')
    // The folder the user chose instead of Downloads, by its own name.
    expect(folderNameOf('/home/b/Pictures/Captures/Screenshot.png')).toBe('Captures')
    expect(folderNameOf('D:\\captures\\Screenshot.png')).toBe('captures')
    expect(folderNameOf('/storage/emulated/0/Documents/Forms/mooring.pdf')).toBe('Forms')
    // Doubled separators read as one.
    expect(folderNameOf('/home/b//Pictures//Screenshot.png')).toBe('Pictures')
  })

  it('names Android’s public collection – the directory `Download` – as its Files app does, "Downloads", for every save toast', () => {
    // The share hub's, the capture card's and the PDF viewer's toasts all read this one function
    // (the lead's ruling on #632: the one mapping, in one place, so the toasts agree by
    // construction).
    expect(folderNameOf('/storage/emulated/0/Download/Screenshot 2026-09-23 at 14.05.09.png')).toBe(
      'Downloads'
    )
    expect(folderNameOf('/storage/emulated/0/Download/mooring (1).pdf')).toBe('Downloads')
    // Below Android 10 the host writes under its own external files: the same directory by name.
    expect(folderNameOf('/storage/emulated/0/Android/data/app.zen/files/Download/x.png')).toBe(
      'Downloads'
    )
    // Only that directory, spelt as Android spells it: another folder keeps its own name.
    expect(folderNameOf('/storage/emulated/0/Downloads/x.png')).toBe('Downloads')
    expect(folderNameOf('/storage/emulated/0/download/x.png')).toBe('download')
    expect(folderNameOf('/storage/emulated/0/Documents/x.png')).toBe('Documents')
  })

  it('has no folder to name for a bare name or a file at a root; a drive’s root is the drive', () => {
    expect(folderNameOf('Screenshot.png')).toBe('')
    expect(folderNameOf('/Screenshot.png')).toBe('')
    expect(folderNameOf('')).toBe('')
    expect(folderNameOf('C:\\Screenshot.png')).toBe('C:')
  })
})
