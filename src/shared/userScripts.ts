import type { UserScriptRunAt, UserScriptWorld } from '../core/extensions/api/userScripts'

/**
 * The wire between the page preload (`preload/userScripts.ts`, every frame of every tab) and the
 * `chrome.userScripts` host (`main/platform/extensionApi/userScripts.ts`). The preload asks for
 * the frame's injection plan synchronously at document start, runs the worlds, and relays the
 * worlds' `runtime.sendMessage` / `runtime.connect` traffic; the host pushes `tabs.sendMessage`
 * deliveries and `userScripts.execute` requests down, each answered under a token.
 */
export const USER_SCRIPTS_CHANNELS = {
  /** `sendSync` from a document at document start: what every extension injects into this frame. */
  plan: 'zen-ext:us-plan',
  /** `invoke`: a world's `runtime.sendMessage`; resolves with the extension's answer. */
  message: 'zen-ext:us-message',
  /** Both ways: the life of a `runtime.connect` port a world opened. */
  port: 'zen-ext:us-port',
  /** Host → document: a `tabs.sendMessage` for one extension's worlds in this frame. */
  deliver: 'zen-ext:us-deliver',
  /** Host → document: `userScripts.execute` in one world of this frame. */
  execute: 'zen-ext:us-execute',
  /** Document → host: the answer to a delivery or an execution, by token. */
  answer: 'zen-ext:us-answer',
  /**
   * `sendSync` from an extension context's preload before the shim installs: the extension's
   * toggles (`ShimOptions.toggles`), `userScripts` among them: with it off `chrome.userScripts`
   * throws on access.
   */
  toggles: 'zen-ext:toggles'
} as const

/**
 * The notifications the shim sends the host over its own transport (`zen-ext:notify`) for the
 * extension side of the worlds' messaging, and the events the host pushes back (`__zen.*`).
 */
export const USER_SCRIPTS_SHIM = {
  /** Shim → host: the extension's answer to a `runtime.onUserScriptMessage` delivery. */
  answer: 'userScripts-answer',
  /** Shim → host: the extension's side of a `runtime.onUserScriptConnect` port. */
  port: 'userScripts-port',
  /** Host → shim (`__zen` namespace): the world's side of a port. */
  portEvent: 'us-port',
  /** Host → shim (`__zen` namespace): the extension's toggles changed. */
  togglesEvent: 'toggles'
} as const

/** One script of a world's plan, its sources resolved to code, in registration order. */
export interface WirePlannedScript {
  id: string
  runAt: UserScriptRunAt
  /** One entry per `js` source: a `file` source carries a `//# sourceURL` of its extension URL. */
  code: string[]
}

/** One world an extension runs in a frame: `MAIN` is the page's own, `USER_SCRIPT` an isolated one. */
export interface WireWorldPlan {
  world: UserScriptWorld
  /** Null for the extension's default user-script world, and for `MAIN`. */
  worldId: string | null
  /** The isolated world's CSP; null for `MAIN`. */
  csp: string | null
  /** `userScripts.configureWorld({ messaging })`: whether the world gets `runtime.sendMessage`. */
  messaging: boolean
  scripts: WirePlannedScript[]
}

export interface WireExtensionPlan {
  extensionId: string
  /** Whether the frame is in a private window (`chrome.extension.inIncognitoContext`). */
  incognito: boolean
  worlds: WireWorldPlan[]
}

/** What the preload sends with its plan request: the document's own view of its URL. */
export interface PlanRequest {
  url: string
}

/** A world's `runtime.sendMessage`, from the preload. */
export interface WorldMessage {
  extensionId: string
  worldId: string | null
  message: unknown
}

/**
 * The extension's side of a world's `runtime.sendMessage`: the first response a listener sent,
 * or Chrome's error (no receiver, the port closed without a response, the call was refused
 * because the toggle is off, the extension has no access to the page, or messaging is off for
 * the world).
 */
export interface WorldMessageResult {
  result?: unknown
  error?: string
}

/**
 * A `runtime.connect` port opened by a world, and the traffic on it, in either direction. The
 * `portId` is the preload's (unique per document); the host keys it by frame as well.
 */
export type PortWire =
  | { kind: 'connect'; portId: string; extensionId: string; worldId: string | null; name: string }
  | { kind: 'message'; portId: string; message: unknown }
  | { kind: 'disconnect'; portId: string; error?: string }

/** A `tabs.sendMessage` for the user-script worlds of one extension in one frame. */
export interface WorldDelivery {
  token: number
  extensionId: string
  message: unknown
  /** Chrome's `MessageSender` of the extension context that sent it. */
  sender: unknown
}

/** `userScripts.execute` in one world of one frame. */
export interface WorldExecution {
  token: number
  extensionId: string
  world: UserScriptWorld
  worldId: string | null
  csp: string | null
  messaging: boolean
  incognito: boolean
  code: string[]
  /** False: wait for document idle, as Chrome does without `injectImmediately`. */
  injectImmediately: boolean
}

/** The document's answer to a delivery or an execution. */
export interface WireAnswer {
  token: number
  /** A delivery: whether any world of the extension had an `onMessage` listener. */
  handled?: boolean
  /** A delivery: whether a listener called `sendResponse` (else the port closed silently). */
  responded?: boolean
  /** The first response (a delivery), or the last expression's value (an execution). */
  result?: unknown
  /** An execution that threw, with the error's message. */
  error?: string
}

/** The shim's answer to a `runtime.onUserScriptMessage` delivery (`USER_SCRIPTS_SHIM.answer`). */
export interface ShimMessageAnswer {
  token: number
  /** Whether a listener called `sendResponse` (false: every listener let the channel close). */
  responded: boolean
  result?: unknown
}

/**
 * The extension side of a world's port (`USER_SCRIPTS_SHIM.port`): `accept` once a context
 * built a `Port` for `runtime.onUserScriptConnect`, then its traffic.
 */
export type ShimPortWire =
  | { kind: 'accept'; portId: string }
  | { kind: 'message'; portId: string; message: unknown }
  | { kind: 'disconnect'; portId: string }

/** What `runtime.onUserScriptConnect` carries besides the `Port`'s `name` and `sender`. */
export interface WorldPortInfo {
  portId: string
  name: string
  sender: unknown
}

/** Chrome's error for a message nobody listens to. */
export const NO_RECEIVER_ERROR = 'Could not establish connection. Receiving end does not exist.'

/** Chrome's error for a `sendMessage` whose receiver went away without answering. */
export const PORT_CLOSED_ERROR = 'The message port closed before a response was received.'
