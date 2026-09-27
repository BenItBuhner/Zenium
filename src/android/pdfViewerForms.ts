/**
 * The form layer of the PDF viewer (`pdfViewer.ts`, CT-44): what pdf.js's annotation layer –
 * the widgets of an AcroForm as HTML inputs over the page, `display/annotation_layer.js` – asks
 * of the document around it, and the stylesheet the widgets are drawn with.
 *
 * pdf.js's own viewer builds the layer in `web/annotation_layer_builder.js` (`pdfjs-dist`'s
 * `web/pdf_viewer.mjs`, `AnnotationLayerBuilder`): one `AnnotationLayer` per page, made with
 * the page, a viewport cloned `dontFlip`, the document's `annotationStorage` and a link service,
 * `render`ed once with the page's annotations and `renderForms`, `update`d with the new viewport
 * on every zoom (the widgets are placed in percentages of the layer and sized through the
 * `--total-scale-factor` variable, so a zoom is a CSS change). The viewer here does the same
 * with its own pieces: the link service below in place of `PDFLinkService`, and this stylesheet
 * – the subset of `web/pdf_viewer.css`'s `.annotationLayer` rules the widgets need, flattened
 * (no CSS nesting) for the WebView floor and with the layer's box set by the viewer, since pdf.js
 * sizes it with CSS `round()`, which Chromium 113 has not got.
 *
 * Chrome Android's reference: its PDF viewer (PDFium-based since Chrome 130) fills forms inline
 * and prints through the system print flow; Chrome desktop's saves through the download flow.
 */

/** The class of the layer over each page; pdf.js's own name kept beside it for anyone reading the DOM. */
export const PDF_FORMS_LAYER_CLASS = 'zen-pdf-forms annotationLayer'

/**
 * The widgets' stylesheet: `web/pdf_viewer.css`'s `.annotationLayer` rules (lines 809–1117 of
 * pdfjs-dist 6.3's copy) that text fields, checkboxes, radio buttons, choice lists and push
 * buttons use, the rotation transforms (6237–6245) and the page's scale variables (6300–6303),
 * keyed on the viewer's own page and layer classes. Popups, media, file attachments and the
 * forced-colours block are left out: the layer is given widgets only.
 */
export const PDF_FORMS_CSS = `
.zen-pdf-page { --user-unit: 1; --total-scale-factor: calc(var(--scale-factor) * var(--user-unit)); --scale-round-x: 1px; --scale-round-y: 1px; }
.zen-pdf-forms {
  color-scheme: only light;
  --annotation-unfocused-field-background: url("data:image/svg+xml;charset=UTF-8,<svg width='1px' height='1px' xmlns='http://www.w3.org/2000/svg'><rect width='100%' height='100%' style='fill:rgba(0, 54, 255, 0.13);'/></svg>");
  --annotation-unfocused-field-filter: url("data:image/svg+xml;charset=UTF-8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='pdfjsFillableField' x='0%' y='0%' width='100%' height='100%' color-interpolation-filters='sRGB'><feFlood flood-color='rgb(0,54,255)' flood-opacity='0.13' result='f'/><feComposite in='f' in2='SourceGraphic' operator='over'/></filter></svg>#pdfjsFillableField");
  --input-focus-border-color: Highlight;
  --input-focus-outline: 1px solid Canvas;
  --input-unfocused-border-color: transparent;
  --input-disabled-border-color: transparent;
  --input-hover-border-color: black;
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  transform-origin: 0 0;
  z-index: 1;
}
.zen-pdf-forms[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.zen-pdf-forms[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.zen-pdf-forms[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
.zen-pdf-forms[data-main-rotation="90"] .norotate { transform: rotate(270deg) translateX(-100%); }
.zen-pdf-forms[data-main-rotation="180"] .norotate { transform: rotate(180deg) translate(-100%, -100%); }
.zen-pdf-forms[data-main-rotation="270"] .norotate { transform: rotate(90deg) translateY(-100%); }
.zen-pdf-forms .annotationContent { position: absolute; width: 100%; height: 100%; pointer-events: none; }
.zen-pdf-forms section { position: absolute; text-align: initial; pointer-events: auto; box-sizing: border-box; transform-origin: 0 0; -webkit-user-select: none; user-select: none; }
.zen-pdf-forms section:has(div.annotationContent) canvas.annotationContent { display: none; }
.zen-pdf-forms .hasOwnCanvas:not(.sandboxModified) :is(input, textarea) { display: none; }
.zen-pdf-forms .hasOwnCanvas.sandboxModified canvas.annotationContent { display: none; }
.zen-pdf-forms :is(.linkAnnotation, .buttonWidgetAnnotation.pushButton) > a { position: absolute; font-size: 1em; top: 0; left: 0; width: 100%; height: 100%; }
.zen-pdf-forms :is(.linkAnnotation, .buttonWidgetAnnotation.pushButton):not(.hasBorder) > a:hover { opacity: 0.2; background-color: rgb(255 255 0); }
.zen-pdf-forms .linkAnnotation.hasBorder:hover { background-color: rgb(255 255 0 / 0.2); }
.zen-pdf-forms .hasBorder { background-size: 100% 100%; }
.zen-pdf-forms .textWidgetAnnotation :is(input, textarea),
.zen-pdf-forms .choiceWidgetAnnotation select,
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) input {
  background-image: var(--annotation-unfocused-field-background);
  border: 2px solid var(--input-unfocused-border-color);
  box-sizing: border-box;
  font: calc(9px * var(--total-scale-factor)) sans-serif;
  height: 100%;
  margin: 0;
  vertical-align: top;
  width: 100%;
}
.zen-pdf-forms .textWidgetAnnotation :is(input, textarea):required,
.zen-pdf-forms .choiceWidgetAnnotation select:required,
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:required { outline: 1.5px solid red; }
.zen-pdf-forms .choiceWidgetAnnotation select option { padding: 0; }
.zen-pdf-forms .textWidgetAnnotation textarea { resize: none; }
.zen-pdf-forms .textWidgetAnnotation :is(input, textarea)[disabled],
.zen-pdf-forms .choiceWidgetAnnotation select[disabled],
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) input[disabled] { background: none; border: 2px solid var(--input-disabled-border-color); cursor: not-allowed; }
.zen-pdf-forms .textWidgetAnnotation :is(input, textarea):hover,
.zen-pdf-forms .choiceWidgetAnnotation select:hover,
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:hover { border: 2px solid var(--input-hover-border-color); }
.zen-pdf-forms .textWidgetAnnotation :is(input, textarea):hover,
.zen-pdf-forms .choiceWidgetAnnotation select:hover,
.zen-pdf-forms .buttonWidgetAnnotation.checkBox input:hover { border-radius: 2px; }
.zen-pdf-forms .textWidgetAnnotation :is(input, textarea):focus,
.zen-pdf-forms .choiceWidgetAnnotation select:focus { background: none; border: 2px solid var(--input-focus-border-color); border-radius: 2px; outline: var(--input-focus-outline); }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) :focus { background-image: none; background-color: transparent; }
.zen-pdf-forms .buttonWidgetAnnotation.checkBox :focus { border: 2px solid var(--input-focus-border-color); border-radius: 2px; outline: var(--input-focus-outline); }
.zen-pdf-forms .buttonWidgetAnnotation.radioButton :focus { border: 2px solid var(--input-focus-border-color); outline: var(--input-focus-outline); }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) [data-canvas-name] { filter: var(--annotation-unfocused-field-filter); }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton):focus-within [data-canvas-name] { filter: none; }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) [data-canvas-name="checked"]:has(~ input:checked) { display: block; }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) [data-canvas-name="checked"]:has(~ input:not(:checked)) { display: none; }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) [data-canvas-name="unchecked"]:has(~ input:checked) { display: none; }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) [data-canvas-name="unchecked"]:has(~ input:not(:checked)) { display: block; }
.zen-pdf-forms .textWidgetAnnotation input.comb { --comb-width: 0px; --comb-letter-spacing: calc(var(--comb-width) - 1ch); font-family: monospace; letter-spacing: var(--comb-letter-spacing); overflow-x: hidden; padding: 0; text-indent: calc(var(--comb-offset, 0) * var(--comb-width) + var(--comb-letter-spacing) / 2); }
.zen-pdf-forms .textWidgetAnnotation input.comb:focus { background-image: repeating-linear-gradient(to right, transparent 0 calc(var(--comb-width) - 1px), var(--input-focus-border-color) calc(var(--comb-width) - 1px) var(--comb-width)); }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton) input { -webkit-appearance: none; appearance: none; }
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton):has([data-canvas-name="checked"]) input:checked,
.zen-pdf-forms .buttonWidgetAnnotation:is(.checkBox, .radioButton):has([data-canvas-name="unchecked"]) input:not(:checked) { background-image: none; }
`

/**
 * What the layer's elements call on their `linkService` (`display/annotation_layer.js`:
 * `LinkAnnotationElement.render` and its `_bind*` helpers, which a push button goes through, and
 * `WidgetAnnotationElement._setEventListener`, which dispatches on `eventBus` only with
 * scripting on). pdf.js's `PDFLinkService` (`web/pdf_link_service.js`) is the viewer
 * application's; this is the part of it a document of widgets needs.
 */
export interface PdfFormLinkService {
  /** No event bus: no scripting sandbox to dispatch to. */
  readonly eventBus: null
  readonly isInPresentationMode: false
  readonly externalLinkEnabled: boolean
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void
  getDestinationHash(dest: unknown): string
  getAnchorUrl(anchor: string): string
  goToDestination(dest: unknown): Promise<void>
  executeNamedAction(action: string): void
  executeSetOCGState(action: unknown): void
  getAttachmentContent(id: string): Promise<null>
}

/** What the link service asks of the viewer: a move to a destination or a page. */
export interface PdfFormNavigation {
  goToDestination(dest: string | unknown[]): void
  /** A named action's page: `first`, `last`, or one step from the current page. */
  goToPage(target: 'first' | 'last' | 'next' | 'prev'): void
}

/** The named actions of PDF 32000-1 §12.6.4.11 the viewer can carry out. */
const NAMED_ACTION_PAGES: Record<string, 'first' | 'last' | 'next' | 'prev'> = {
  FirstPage: 'first',
  LastPage: 'last',
  NextPage: 'next',
  PrevPage: 'prev'
}

/** A link service over the viewer's own navigation; anything a document of widgets cannot mean is ignored. */
export function pdfFormLinkService(viewer: PdfFormNavigation): PdfFormLinkService {
  return {
    eventBus: null,
    isInPresentationMode: false,
    externalLinkEnabled: true,
    addLinkAttributes: (link, url, newWindow) => {
      // A push button's URI action: the page's own link, as the viewer's link layer makes them.
      if (!/^https?:/i.test(url)) return
      link.href = url
      link.rel = 'noreferrer'
      if (newWindow) link.target = '_blank'
    },
    getDestinationHash: () => '#',
    getAnchorUrl: () => '#',
    goToDestination: async (dest) => {
      if (typeof dest === 'string' || Array.isArray(dest)) viewer.goToDestination(dest)
    },
    executeNamedAction: (action) => {
      const target = NAMED_ACTION_PAGES[action]
      if (target) viewer.goToPage(target)
    },
    executeSetOCGState: () => {},
    getAttachmentContent: async () => null
  }
}

/**
 * The bytes as base64, for the host's `saveFile` (Android's `download.saveFile` takes the file
 * that way): in slices, since `String.fromCharCode(...bytes)` on a document's worth of bytes
 * overflows the argument list.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += SLICE)
    binary += String.fromCharCode(...bytes.subarray(at, at + SLICE))
  return btoa(binary)
}
