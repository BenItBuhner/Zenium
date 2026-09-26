/**
 * The main side of the page preload's one document-start ask (`shared/documentStart.ts`): a
 * composed `ipcMain.on(DOCUMENT_START_CHANNEL, …)` handler over a registry of PROVIDERS, one
 * per field of the answer, each registered by the service that owns the answer at its startup –
 * the privacy signals (`privacy.ts`), the display mode (`index.ts`'s IPC) and the content guards
 * (`contentRules.ts`) by services; the user-script plan by the extension host from its own file
 * (`extensionApi/index.ts`, `install()`). The registry and this handler are services'.
 *
 * The rules (the interface agreed with extensions): every provider is called EXACTLY ONCE per
 * ask, in field order, never cached and never skipped when a sibling throws – the user-script
 * plan is the document's REGISTRATION with the extension host (it drops the previous document's
 * worlds for the frame, tracks the new ones, arms the per-page listeners on a `WebContents`'
 * first ask), so an ask that did not reach it would break user scripts. Each provider runs in
 * its own try/catch; a throw leaves that field at its default with the other fields intact.
 * `returnValue` is always set: the page blocks on it.
 */
import { ipcMain, type IpcMain, type IpcMainEvent } from 'electron'
import {
  DOCUMENT_START_CHANNEL,
  DOCUMENT_START_FIELDS,
  documentStartDefaults,
  type DocumentStartAnswer,
  type DocumentStartField,
  type DocumentStartRequest
} from '../../shared/documentStart'

/** The ask's sender, as a provider reads it: the page's `WebContents` and the asking frame. */
export type DocumentStartEvent = Pick<IpcMainEvent, 'sender' | 'senderFrame'>

/** The answer of one field for one ask; a throw is that field's default. */
export type DocumentStartProvider<K extends DocumentStartField> = (
  event: DocumentStartEvent,
  request: DocumentStartRequest
) => DocumentStartAnswer[K]

type Providers = { [K in DocumentStartField]?: DocumentStartProvider<K> }

export class DocumentStartRegistry {
  private readonly providers: Providers = {}

  /** Register a field's provider; a second registration of the same field replaces the first. */
  register<K extends DocumentStartField>(name: K, provider: DocumentStartProvider<K>): void {
    // Seen through the one field being written, so the write is typed by that field alone.
    const slot: { [P in K]?: DocumentStartProvider<P> } = this.providers
    slot[name] = provider
  }

  /** One ask's answer: every registered provider once, in field order, its default on a throw. */
  answer(event: DocumentStartEvent, request: DocumentStartRequest): DocumentStartAnswer {
    const answer = documentStartDefaults()
    for (const name of DOCUMENT_START_FIELDS) this.fill(answer, name, event, request)
    return answer
  }

  /** The one `ipcMain.on` of the channel; the page's `sendSync` blocks on `returnValue`. */
  attach(ipc: Pick<IpcMain, 'on'> = ipcMain): void {
    ipc.on(DOCUMENT_START_CHANNEL, (event, raw: unknown) => {
      event.returnValue = this.answer(event, documentStartRequest(raw))
    })
  }

  private fill<K extends DocumentStartField>(
    answer: DocumentStartAnswer,
    name: K,
    event: DocumentStartEvent,
    request: DocumentStartRequest
  ): void {
    const provider = this.providers[name]
    if (!provider) return
    try {
      answer[name] = provider(event, request)
    } catch (error) {
      console.warn(`[zen] document-start ${name} failed:`, error)
    }
  }
}

/** The request as the preload sent it, or an empty URL for anything else. */
function documentStartRequest(raw: unknown): DocumentStartRequest {
  if (raw && typeof raw === 'object' && typeof (raw as { url?: unknown }).url === 'string')
    return { url: (raw as { url: string }).url }
  return { url: '' }
}

/** The app's registry: the owning services register into it at startup, before any page loads. */
export const documentStart = new DocumentStartRegistry()

export function registerDocumentStartProvider<K extends DocumentStartField>(
  name: K,
  provider: DocumentStartProvider<K>
): void {
  documentStart.register(name, provider)
}

/** Install the composed handler on `ipcMain`; once, before the first document (`index.ts`). */
export function attachDocumentStart(): void {
  documentStart.attach()
}
