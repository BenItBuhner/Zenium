/**
 * The viewer's save path through pdf.js itself (`Viewer.save` → `saveDocument`), run in Node
 * on the preview host's form fixture (`previewPdf('form')`, the mooring application): the
 * storage flags the first change the way the viewer's modified gate reads it, pdf.js writes the
 * values into an incremental update, and the copy read back holds them. The DOM layer over the
 * page is pdf.js's own (`AnnotationLayer`) and is not built here.
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PREVIEW_FORM_FIELDS, previewPdf } from '../previewPdf'
import { fillableFieldCount, PdfFormGate, type PdfFormStorageLike } from '../pdfViewerForms'

/** What `getAnnotations` says of a widget, the part the layer and these tests read. */
interface Widget {
  id: string
  annotationType: number
  fieldName: string
  fieldType: string
  fieldValue: unknown
  exportValue?: string
  buttonValue?: string | null
  hasOwnCanvas?: boolean
  resetForm?: unknown
  options?: Array<{ exportValue: string; displayValue: string }>
}

interface Opened {
  doc: PDFDocumentProxy
  /** The document's storage with the hooks the viewer sets, typed as pdf.js leaves them. */
  storage: {
    setValue(id: string, value: { value: unknown }): void
    resetModified(): void
    onSetModified: (() => void) | null
    onResetModified: (() => void) | null
    readonly size: number
  }
  close(): Promise<void>
}

async function open(bytes: Uint8Array): Promise<Opened> {
  const task = pdfjs.getDocument({
    // A copy: pdf.js transfers the buffer it is given to its worker, leaving the caller's empty.
    data: bytes.slice(),
    // pdf.js's data folders, as the viewer hands them (`Viewer.asset`); here from node_modules.
    standardFontDataUrl: `${resolve('node_modules/pdfjs-dist/standard_fonts')}/`,
    verbosity: 0
  })
  const doc = await task.promise
  return {
    doc,
    storage: doc.annotationStorage as unknown as Opened['storage'],
    close: () => task.destroy()
  }
}

/** The first page's widgets by field name; a radio group's kids by name and button value. */
async function widgetsOf(doc: PDFDocumentProxy): Promise<Map<string, Widget>> {
  const page = await doc.getPage(1)
  const annotations = (await page.getAnnotations({ intent: 'display' })) as Widget[]
  const byName = new Map<string, Widget>()
  for (const widget of annotations) {
    if (widget.annotationType !== pdfjs.AnnotationType.WIDGET) continue
    const key = widget.buttonValue ? `${widget.fieldName}:${widget.buttonValue}` : widget.fieldName
    byName.set(key, widget)
  }
  return byName
}

const F = PREVIEW_FORM_FIELDS

describe('the form fixture through pdf.js', () => {
  it('holds seven fields of every widget kind the layer renders, with no JavaScript to run', async () => {
    const { doc, close } = await open(previewPdf('form'))
    try {
      const fields = await doc.getFieldObjects()
      expect([...(fields?.keys() ?? [])].sort()).toEqual(Object.values(F).sort())
      expect(await doc.hasJSActions()).toBe(false)
      const widgets = await widgetsOf(doc)
      expect(widgets.get(F.applicant)).toMatchObject({ fieldType: 'Tx', fieldValue: '' })
      expect(widgets.get(F.vessel)).toMatchObject({ fieldType: 'Tx', fieldValue: 'Grey Seal' })
      expect(widgets.get(F.notes)).toMatchObject({ fieldType: 'Tx' })
      // The radio group's kids draw their own faces: the render paints them into the layer's
      // canvases (`hasOwnCanvas`), and the checked one is the field's value.
      expect(widgets.get(`${F.berth}:Pontoon`)).toMatchObject({
        fieldType: 'Btn',
        hasOwnCanvas: true,
        fieldValue: 'Pontoon'
      })
      expect(widgets.get(`${F.berth}:Swinging`)).toMatchObject({ fieldType: 'Btn' })
      expect(widgets.get(F.electricity)).toMatchObject({
        fieldType: 'Btn',
        exportValue: 'Yes',
        fieldValue: 'Off'
      })
      expect(widgets.get(F.season)).toMatchObject({ fieldType: 'Ch', fieldValue: ['Season'] })
      expect(widgets.get(F.season)?.options?.map((o) => o.exportValue)).toEqual([
        'Short stay',
        'Season',
        'Annual'
      ])
      expect(widgets.get(F.clear)).toMatchObject({ fieldType: 'Btn' })
      expect(widgets.get(F.clear)?.resetForm).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('flags the first change once, writes the values into a copy, and reads them back from it', async () => {
    const original = previewPdf('form')
    const { doc, storage, close } = await open(original)
    let flagged = 0
    let reset = 0
    storage.onSetModified = () => flagged++
    storage.onResetModified = () => reset++
    try {
      const widgets = await widgetsOf(doc)
      const id = (key: string): string => widgets.get(key)!.id
      storage.setValue(id(F.applicant), { value: 'Ann Mooring' })
      storage.setValue(id(F.electricity), { value: true })
      storage.setValue(id(`${F.berth}:Pontoon`), { value: false })
      storage.setValue(id(`${F.berth}:Swinging`), { value: true })
      storage.setValue(id(F.season), { value: 'Annual' })
      storage.setValue(id(F.notes), { value: 'Arriving late April.\nNeeds a hose.' })
      // The gate the viewer's `form.modified` follows: the first change, once.
      expect(flagged).toBe(1)
      expect(storage.size).toBe(6)
      const saved = await doc.saveDocument()
      // An incremental update: the file as it was, the changed fields appended after it.
      expect(saved.length).toBeGreaterThan(original.length)
      expect(Buffer.from(saved.subarray(0, original.length)).equals(original)).toBe(true)
      expect(reset).toBe(1)
      const copy = await open(saved)
      try {
        const after = await widgetsOf(copy.doc)
        expect(after.get(F.applicant)?.fieldValue).toBe('Ann Mooring')
        expect(after.get(F.vessel)?.fieldValue).toBe('Grey Seal')
        expect(after.get(F.electricity)?.fieldValue).toBe('Yes')
        expect(after.get(`${F.berth}:Swinging`)?.fieldValue).toBe('Swinging')
        expect(after.get(F.season)?.fieldValue).toEqual(['Annual'])
        expect(after.get(F.notes)?.fieldValue).toBe('Arriving late April.\nNeeds a hose.')
        expect(copy.doc.numPages).toBe(1)
      } finally {
        await copy.close()
      }
    } finally {
      await close()
    }
  })

  it('saves an untouched form as the file itself', async () => {
    const original = previewPdf('form')
    const { doc, storage, close } = await open(original)
    try {
      expect(storage.size).toBe(0)
      const saved = await doc.saveDocument()
      expect(Buffer.from(saved).equals(original)).toBe(true)
      // What a print of the untouched form hands the host (`Viewer.bytes`): the file's own bytes.
      expect(Buffer.from(await doc.getData()).equals(original)).toBe(true)
    } finally {
      await close()
    }
  })

  it('counts six fillable fields: the reset button holds no value a save could write', async () => {
    const { doc, close } = await open(previewPdf('form'))
    try {
      const fields = await doc.getFieldObjects()
      expect(fields?.size).toBe(7)
      expect(fillableFieldCount(fields)).toBe(6)
      const kinds = new Map(
        [...(fields?.entries() ?? [])].map(([name, objects]): [string, string] => [
          name,
          (objects as Array<{ type: string }>).map((o) => o.type).join('+')
        ])
      )
      expect(kinds.get(F.clear)).toBe('button')
      // A radio group's name holds the group's own object (`type: ""`, the field with kids;
      // `Annotation.getFieldObject`) before its two buttons: one fillable field.
      expect(kinds.get(F.berth)).toBe('+radiobutton+radiobutton')
    } finally {
      await close()
    }
  })

  it('keeps the form modified through a save that an edit overtook, on pdf.js’s own digest', async () => {
    const { doc, storage, close } = await open(previewPdf('form'))
    const gate = new PdfFormGate(() => doc.annotationStorage as unknown as PdfFormStorageLike)
    storage.onSetModified = () => gate.edited()
    try {
      const widgets = await widgetsOf(doc)
      const id = (key: string): string => widgets.get(key)!.id
      storage.setValue(id(F.applicant), { value: 'Ann Mooring' })
      expect(gate.modified).toBe(true)
      // Save: the copy is made of the values as they stand …
      gate.copying()
      const copy = await doc.saveDocument()
      expect(copy.length).toBeGreaterThan(0)
      // … the host is writing it, and the user types on – pdf.js's flag was reset by the save,
      // so this is a first change again and the hook fires; the viewer's flag was true already.
      storage.setValue(id(F.notes), { value: 'Arriving late April.' })
      // The host's `saved` for the copy: the values are no longer the copy's, so still modified.
      expect(gate.saved()).toBe(false)
      expect(gate.modified).toBe(true)
      // A second save takes the new values; its `saved` clears the flag.
      gate.copying()
      await doc.saveDocument()
      expect(gate.saved()).toBe(true)
      expect(gate.modified).toBe(false)
      // The next edit is a first change for pdf.js too: the hook fires and the gate follows.
      storage.setValue(id(F.electricity), { value: true })
      expect(gate.modified).toBe(true)
    } finally {
      await close()
    }
  })
})
