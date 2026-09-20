import { describe, expect, it } from 'vitest'
import { OPEN_SETTINGS_LABEL, showHostToast, type HostToastIo } from '../hostToast'

/*
 * OS-22: the file chooser's camera refused is a toast the host raises itself; a refusal for
 * good carries Open settings, the app's details page.
 */

type Shown = { message: string; kind: string; action?: { label: string; onPick: () => void } }

function io(): HostToastIo & { shown: Shown[]; settingsOpened: number } {
  const rec = {
    shown: [] as Shown[],
    settingsOpened: 0,
    toast: (message: string, kind: 'info' | 'error', action?: Shown['action']) => {
      rec.shown.push({ message, kind, action })
    },
    openSettings: () => {
      rec.settingsOpened++
    }
  }
  return rec
}

describe("the host's own toast on the chrome's cards", () => {
  it('shows the message as an info toast without an action by default', () => {
    const rec = io()
    expect(showHostToast({ message: 'Camera access is needed to take a photo' }, rec)).toBe(true)
    expect(rec.shown).toEqual([
      { message: 'Camera access is needed to take a photo', kind: 'info', action: undefined }
    ])
  })

  it('gives a refusal for good Open settings, which opens the app details', () => {
    const rec = io()
    showHostToast({ message: 'Camera access is turned off for Zenium', action: 'settings' }, rec)
    const [toast] = rec.shown
    expect(toast?.action?.label).toBe(OPEN_SETTINGS_LABEL)
    expect(OPEN_SETTINGS_LABEL).toBe('Open settings')
    toast?.action?.onPick()
    expect(rec.settingsOpened).toBe(1)
  })

  it('keeps an error kind and drops anything else to info', () => {
    const rec = io()
    showHostToast({ message: 'x', kind: 'error' }, rec)
    showHostToast({ message: 'y', kind: 'loud' }, rec)
    expect(rec.shown.map((t) => t.kind)).toEqual(['error', 'info'])
  })

  it('shows nothing for a payload without a message', () => {
    const rec = io()
    expect(showHostToast(null, rec)).toBe(false)
    expect(showHostToast({}, rec)).toBe(false)
    expect(showHostToast({ message: '' }, rec)).toBe(false)
    expect(showHostToast({ message: 7 }, rec)).toBe(false)
    expect(rec.shown).toEqual([])
  })
})
