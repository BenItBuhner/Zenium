/**
 * The table of `chrome.*` members the Zenium browser layer provides on top of the engine's own
 * bindings. It is plain data on purpose: the context-side shim (`shim.ts`) is stringified into
 * extension pages and receives this table as an argument, and the host-side router validates
 * incoming calls against the same table.
 *
 * Every method is a callback-or-promise call routed to the host; `keepNative` members are only
 * defined when the engine does not already provide them (Electron's implementation of those
 * works), everything else replaces the engine's inert binding in place.
 */

export type ParamType = 'integer' | 'number' | 'string' | 'boolean' | 'object' | 'array' | 'any'

export interface ParamSpec {
  name: string
  type: ParamType | ParamType[]
  optional?: boolean
}

export interface MethodSpec {
  params: ParamSpec[]
  /** Leave the engine's binding alone when it exists (it works natively). */
  keepNative?: boolean
  /**
   * Answered on the context side, never reaching the host: the shape of a member the browser
   * layer does not implement (or has nothing to say about, like `cookies.getPartitionKey` in a
   * browser without per-site cookie partitions), so an extension that touches it runs on.
   * `value` goes to the callback or promise; `id` answers with the caller's own id (a string
   * first argument or `createProperties.id`) or a generated one of that type; `sync` also returns
   * the id synchronously. Turning one into a routed call is deleting the flag and adding the
   * host handler.
   */
  inert?: { value?: unknown; id?: 'number' | 'string'; sync?: boolean }
}

export interface EventSpec {
  /** Documents keep receiving this event from the engine; the shim only adds the host's deliveries. */
  nativeInFrames?: boolean
  keepNative?: boolean
  /**
   * `webRequest` events: the `extraInfoSpec` values the event accepts (`blocking` among them
   * for the events with a blocking variant). The shim validates registrations against the list.
   */
  extraInfoSpec?: readonly string[]
}

export interface NamespaceSpec {
  methods: Record<string, MethodSpec>
  events: Record<string, EventSpec>
  constants?: Record<string, number | string | Record<string, string>>
  /** Only exists in this manifest version (`action` is MV3, `browserAction` MV2). */
  manifestVersion?: 2 | 3
  /**
   * The whole namespace is a shape (every method `inert`, events that nothing fires yet):
   * absent from the engine, pending in the browser layer, but registered against at start-up
   * by many extensions, which would otherwise never get past their first statement.
   */
  shape?: true
  /**
   * Chrome hides permission-gated namespaces: this one exists only for extensions whose
   * manifest lists one of these permissions (the engine's own namespace, when it made one, is
   * patched regardless).
   */
  permissions?: readonly string[]
  /**
   * `webRequest`: the events take `(callback, RequestFilter filter, extraInfoSpec)` instead of
   * Chrome's generic `(callback, filters)`, and a delivery to a `blocking` listener carries a
   * token the shim answers with the listener's return value. The shim builds these events
   * itself from `EventSpec.extraInfoSpec`.
   */
  eventStyle?: 'webRequest'
}

export type ApiSpec = Record<string, NamespaceSpec>

const integer = (name: string, optional = false): ParamSpec => ({ name, type: 'integer', optional })
const object = (name: string, optional = false): ParamSpec => ({ name, type: 'object', optional })
const string = (name: string, optional = false): ParamSpec => ({ name, type: 'string', optional })
const boolean = (name: string, optional = false): ParamSpec => ({ name, type: 'boolean', optional })

const ACTION_METHODS: Record<string, MethodSpec> = {
  setTitle: { params: [object('details')] },
  getTitle: { params: [object('details')] },
  setIcon: { params: [object('details')] },
  setPopup: { params: [object('details')] },
  getPopup: { params: [object('details')] },
  setBadgeText: { params: [object('details')] },
  getBadgeText: { params: [object('details')] },
  setBadgeBackgroundColor: { params: [object('details')] },
  getBadgeBackgroundColor: { params: [object('details')] },
  setBadgeTextColor: { params: [object('details')] },
  getBadgeTextColor: { params: [object('details')] },
  enable: { params: [integer('tabId', true)] },
  disable: { params: [integer('tabId', true)] },
  isEnabled: { params: [integer('tabId', true)] },
  getUserSettings: { params: [] },
  openPopup: { params: [object('options', true)] }
}

export const API_SPEC: ApiSpec = {
  tabs: {
    methods: {
      create: { params: [object('createProperties')] },
      remove: { params: [{ name: 'tabIds', type: ['integer', 'array'] }] },
      update: { params: [integer('tabId', true), object('updateProperties')] },
      get: { params: [integer('tabId')] },
      getCurrent: { params: [] },
      query: { params: [object('queryInfo')] },
      move: { params: [{ name: 'tabIds', type: ['integer', 'array'] }, object('moveProperties')] },
      duplicate: { params: [integer('tabId')] },
      highlight: { params: [object('highlightInfo')] },
      reload: { params: [integer('tabId', true), object('reloadProperties', true)] },
      goBack: { params: [integer('tabId', true)] },
      goForward: { params: [integer('tabId', true)] },
      discard: { params: [integer('tabId', true)] },
      detectLanguage: { params: [integer('tabId', true)] },
      captureVisibleTab: { params: [integer('windowId', true), object('options', true)] },
      insertCSS: { params: [integer('tabId', true), object('details')] },
      removeCSS: { params: [integer('tabId', true), object('details')] },
      getZoom: { params: [integer('tabId', true)], keepNative: true },
      setZoom: {
        params: [integer('tabId', true), { name: 'zoomFactor', type: 'number' }],
        keepNative: true
      },
      getAllInWindow: { params: [integer('windowId', true)] },
      getSelected: { params: [integer('windowId', true)] }
    },
    events: {
      onCreated: {},
      onUpdated: {},
      onActivated: {},
      onRemoved: {},
      onMoved: {},
      onReplaced: {},
      onAttached: {},
      onDetached: {},
      onHighlighted: {},
      onZoomChange: {},
      onActiveChanged: {},
      onSelectionChanged: {},
      onHighlightChanged: {}
    },
    constants: {
      TAB_ID_NONE: -1,
      MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
      TabStatus: { UNLOADED: 'unloaded', LOADING: 'loading', COMPLETE: 'complete' },
      MutedInfoReason: { USER: 'user', CAPTURE: 'capture', EXTENSION: 'extension' },
      WindowType: {
        NORMAL: 'normal',
        POPUP: 'popup',
        PANEL: 'panel',
        APP: 'app',
        DEVTOOLS: 'devtools'
      }
    }
  },
  windows: {
    methods: {
      get: { params: [integer('windowId'), object('queryOptions', true)] },
      getCurrent: { params: [object('queryOptions', true)] },
      getLastFocused: { params: [object('queryOptions', true)] },
      getAll: { params: [object('queryOptions', true)] },
      create: { params: [object('createData', true)] },
      update: { params: [integer('windowId'), object('updateInfo')] },
      remove: { params: [integer('windowId')] }
    },
    events: { onCreated: {}, onRemoved: {}, onFocusChanged: {}, onBoundsChanged: {} },
    constants: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      WindowType: {
        NORMAL: 'normal',
        POPUP: 'popup',
        PANEL: 'panel',
        APP: 'app',
        DEVTOOLS: 'devtools'
      },
      WindowState: {
        NORMAL: 'normal',
        MINIMIZED: 'minimized',
        MAXIMIZED: 'maximized',
        FULLSCREEN: 'fullscreen',
        LOCKED_FULLSCREEN: 'locked-fullscreen'
      },
      CreateType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel' }
    }
  },
  runtime: {
    methods: {
      openOptionsPage: { params: [] },
      setUninstallURL: { params: [string('url')] }
    },
    events: { onInstalled: {}, onStartup: {} }
  },
  action: { methods: ACTION_METHODS, events: { onClicked: {} }, manifestVersion: 3 },
  browserAction: { methods: ACTION_METHODS, events: { onClicked: {} }, manifestVersion: 2 },
  alarms: {
    methods: {
      create: { params: [string('name', true), object('alarmInfo')] },
      get: { params: [string('name', true)] },
      getAll: { params: [] },
      clear: { params: [string('name', true)] },
      clearAll: { params: [] }
    },
    events: { onAlarm: {} }
  },
  permissions: {
    methods: {
      getAll: { params: [] },
      contains: { params: [object('permissions')] },
      request: { params: [object('permissions')] },
      remove: { params: [object('permissions')] }
    },
    events: { onAdded: {}, onRemoved: {} }
  },
  extension: {
    methods: {
      isAllowedIncognitoAccess: { params: [] },
      isAllowedFileSchemeAccess: { params: [] },
      setUpdateUrlData: { params: [string('data')] }
    },
    events: {},
    constants: {
      ViewType: { TAB: 'tab', POPUP: 'popup' }
    }
  },
  management: {
    methods: {
      getAll: { params: [] },
      get: { params: [string('id')] },
      getSelf: { params: [], keepNative: true },
      setEnabled: { params: [string('id'), boolean('enabled')] },
      uninstall: { params: [string('id'), object('options', true)] },
      uninstallSelf: { params: [object('options', true)] },
      getPermissionWarningsById: { params: [string('id')] },
      getPermissionWarningsByManifest: { params: [string('manifestStr')] },
      launchApp: { params: [string('id')] },
      createAppShortcut: { params: [string('id')] },
      setLaunchType: { params: [string('id'), string('launchType')] },
      generateAppForLink: { params: [string('url'), string('title')] }
    },
    events: { onInstalled: {}, onUninstalled: {}, onEnabled: {}, onDisabled: {} },
    constants: {
      ExtensionInstallType: {
        ADMIN: 'admin',
        DEVELOPMENT: 'development',
        NORMAL: 'normal',
        SIDELOAD: 'sideload',
        OTHER: 'other'
      },
      ExtensionType: {
        EXTENSION: 'extension',
        HOSTED_APP: 'hosted_app',
        PACKAGED_APP: 'packaged_app',
        LEGACY_PACKAGED_APP: 'legacy_packaged_app',
        THEME: 'theme',
        LOGIN_SCREEN_EXTENSION: 'login_screen_extension'
      },
      ExtensionDisabledReason: { UNKNOWN: 'unknown', PERMISSIONS_INCREASE: 'permissions_increase' },
      LaunchType: {
        OPEN_AS_REGULAR_TAB: 'OPEN_AS_REGULAR_TAB',
        OPEN_AS_PINNED_TAB: 'OPEN_AS_PINNED_TAB',
        OPEN_AS_WINDOW: 'OPEN_AS_WINDOW',
        OPEN_FULL_SCREEN: 'OPEN_FULL_SCREEN'
      }
    }
  },

  // Browser layer part 2 namespaces. Electron 44 has none of them; every member routes to the
  // host and every event is fired from there (webNavigation from the tab views' navigation
  // events, contextMenus from the page and toolbar menus, commands from the key handler,
  // notifications from the native notification, cookies from the sessions' cookie stores).
  webNavigation: {
    methods: {
      getFrame: { params: [object('details')] },
      getAllFrames: { params: [object('details')] }
    },
    events: {
      onBeforeNavigate: {},
      onCommitted: {},
      onDOMContentLoaded: {},
      onCompleted: {},
      onErrorOccurred: {},
      onCreatedNavigationTarget: {},
      onReferenceFragmentUpdated: {},
      onTabReplaced: {},
      onHistoryStateUpdated: {}
    },
    constants: {
      TransitionType: {
        LINK: 'link',
        TYPED: 'typed',
        AUTO_BOOKMARK: 'auto_bookmark',
        AUTO_SUBFRAME: 'auto_subframe',
        MANUAL_SUBFRAME: 'manual_subframe',
        GENERATED: 'generated',
        START_PAGE: 'start_page',
        FORM_SUBMIT: 'form_submit',
        RELOAD: 'reload',
        KEYWORD: 'keyword',
        KEYWORD_GENERATED: 'keyword_generated'
      },
      TransitionQualifier: {
        CLIENT_REDIRECT: 'client_redirect',
        SERVER_REDIRECT: 'server_redirect',
        FORWARD_BACK: 'forward_back',
        FROM_ADDRESS_BAR: 'from_address_bar'
      }
    }
  },
  contextMenus: {
    methods: {
      // `create` returns the id synchronously; the shim special-cases it (see `shim.ts`) and
      // passes the id it generated as a second argument for the host to adopt.
      create: { params: [object('createProperties')] },
      update: {
        params: [{ name: 'id', type: ['integer', 'string'] }, object('updateProperties')]
      },
      remove: { params: [{ name: 'menuItemId', type: ['integer', 'string'] }] },
      removeAll: { params: [] }
    },
    events: { onClicked: {} },
    constants: {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      ContextType: {
        ALL: 'all',
        PAGE: 'page',
        FRAME: 'frame',
        SELECTION: 'selection',
        LINK: 'link',
        EDITABLE: 'editable',
        IMAGE: 'image',
        VIDEO: 'video',
        AUDIO: 'audio',
        LAUNCHER: 'launcher',
        BROWSER_ACTION: 'browser_action',
        PAGE_ACTION: 'page_action',
        ACTION: 'action'
      },
      ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' }
    }
  },
  commands: {
    methods: { getAll: { params: [] } },
    events: { onCommand: {} }
  },
  notifications: {
    methods: {
      create: {
        params: [{ name: 'notificationId', type: 'string', optional: true }, object('options')]
      },
      update: { params: [string('notificationId'), object('options')] },
      clear: { params: [string('notificationId')] },
      getAll: { params: [] },
      getPermissionLevel: { params: [] }
    },
    events: {
      onClosed: {},
      onClicked: {},
      onButtonClicked: {},
      onPermissionLevelChanged: {},
      onShowSettings: {}
    },
    constants: {
      TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' },
      PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' }
    }
  },
  cookies: {
    methods: {
      get: { params: [object('details')] },
      getAll: { params: [object('details')] },
      set: { params: [object('details')] },
      remove: { params: [object('details')] },
      getAllCookieStores: { params: [] },
      // Zenium partitions cookies per container, never per top-level site: the key is empty.
      getPartitionKey: { params: [object('details')], inert: { value: { partitionKey: {} } } }
    },
    events: { onChanged: {} },
    constants: {
      SameSiteStatus: {
        NO_RESTRICTION: 'no_restriction',
        LAX: 'lax',
        STRICT: 'strict',
        UNSPECIFIED: 'unspecified'
      },
      OnChangedCause: {
        EVICTED: 'evicted',
        EXPIRED: 'expired',
        EXPLICIT: 'explicit',
        EXPIRED_OVERWRITE: 'expired_overwrite',
        OVERWRITE: 'overwrite'
      }
    }
  },
  // The engine's own binding is inert without Chrome's rules service (and the blocking engine's
  // hook disables the native path anyway), so every member is replaced by the host's, backed by
  // `core/extensions/dnr`. `testMatchOutcome` and `onRuleMatchedDebug` exist for unpacked
  // extensions only, as in Chrome; the host answers with an error for the others.
  declarativeNetRequest: {
    methods: {
      updateDynamicRules: { params: [object('options')] },
      getDynamicRules: { params: [object('filter', true)] },
      updateSessionRules: { params: [object('options')] },
      getSessionRules: { params: [object('filter', true)] },
      updateEnabledRulesets: { params: [object('options')] },
      getEnabledRulesets: { params: [] },
      updateStaticRules: { params: [object('options')] },
      getDisabledRuleIds: { params: [object('options')] },
      getAvailableStaticRuleCount: { params: [] },
      getMatchedRules: { params: [object('filter', true)] },
      setExtensionActionOptions: { params: [object('options')] },
      isRegexSupported: { params: [object('regexOptions')] },
      testMatchOutcome: { params: [object('request')] }
    },
    events: { onRuleMatchedDebug: {} },
    constants: {
      DYNAMIC_RULESET_ID: '_dynamic',
      SESSION_RULESET_ID: '_session',
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      GETMATCHEDRULES_QUOTA_INTERVAL: 10,
      MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
      ResourceType: {
        MAIN_FRAME: 'main_frame',
        SUB_FRAME: 'sub_frame',
        STYLESHEET: 'stylesheet',
        SCRIPT: 'script',
        IMAGE: 'image',
        FONT: 'font',
        OBJECT: 'object',
        XMLHTTPREQUEST: 'xmlhttprequest',
        PING: 'ping',
        CSP_REPORT: 'csp_report',
        MEDIA: 'media',
        WEBSOCKET: 'websocket',
        WEBTRANSPORT: 'webtransport',
        WEBBUNDLE: 'webbundle',
        OTHER: 'other'
      },
      RuleActionType: {
        BLOCK: 'block',
        REDIRECT: 'redirect',
        ALLOW: 'allow',
        UPGRADE_SCHEME: 'upgradeScheme',
        MODIFY_HEADERS: 'modifyHeaders',
        ALLOW_ALL_REQUESTS: 'allowAllRequests'
      },
      RequestMethod: {
        CONNECT: 'connect',
        DELETE: 'delete',
        GET: 'get',
        HEAD: 'head',
        OPTIONS: 'options',
        PATCH: 'patch',
        POST: 'post',
        PUT: 'put',
        OTHER: 'other'
      },
      DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
      HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' },
      UnsupportedRegexReason: {
        SYNTAX_ERROR: 'syntaxError',
        MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded'
      }
    }
  },
  // Electron has the binding, but the session's own `webRequest` hook (the blocking engine's)
  // switches the engine's extension path off, so the events never fire. The emulation runs the
  // listeners over the same hook (`main/platform/webRequest.ts`): registrations go to the host
  // through the internal `addListener` / `removeListener` calls, deliveries come back addressed
  // to the listener, and a blocking listener's return value travels back as the answer.
  // `onAuthRequired` exists for extensions that probe it; nothing fires it (no session hook).
  webRequest: {
    methods: {
      handlerBehaviorChanged: { params: [], inert: {} }
    },
    events: {
      onBeforeRequest: { extraInfoSpec: ['blocking', 'requestBody', 'extraHeaders'] },
      onBeforeSendHeaders: { extraInfoSpec: ['requestHeaders', 'blocking', 'extraHeaders'] },
      onSendHeaders: { extraInfoSpec: ['requestHeaders', 'extraHeaders'] },
      onHeadersReceived: { extraInfoSpec: ['blocking', 'responseHeaders', 'extraHeaders'] },
      onAuthRequired: {
        extraInfoSpec: ['responseHeaders', 'blocking', 'asyncBlocking', 'extraHeaders']
      },
      onResponseStarted: { extraInfoSpec: ['responseHeaders', 'extraHeaders'] },
      onBeforeRedirect: { extraInfoSpec: ['responseHeaders', 'extraHeaders'] },
      onCompleted: { extraInfoSpec: ['responseHeaders', 'extraHeaders'] },
      onErrorOccurred: { extraInfoSpec: ['extraHeaders'] }
    },
    constants: {
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      ResourceType: {
        MAIN_FRAME: 'main_frame',
        SUB_FRAME: 'sub_frame',
        STYLESHEET: 'stylesheet',
        SCRIPT: 'script',
        IMAGE: 'image',
        FONT: 'font',
        OBJECT: 'object',
        XMLHTTPREQUEST: 'xmlhttprequest',
        PING: 'ping',
        CSP_REPORT: 'csp_report',
        MEDIA: 'media',
        WEBSOCKET: 'websocket',
        WEBBUNDLE: 'webbundle',
        OTHER: 'other'
      },
      OnBeforeRequestOptions: {
        BLOCKING: 'blocking',
        REQUEST_BODY: 'requestBody',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnBeforeSendHeadersOptions: {
        REQUEST_HEADERS: 'requestHeaders',
        BLOCKING: 'blocking',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnHeadersReceivedOptions: {
        BLOCKING: 'blocking',
        RESPONSE_HEADERS: 'responseHeaders',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnAuthRequiredOptions: {
        RESPONSE_HEADERS: 'responseHeaders',
        BLOCKING: 'blocking',
        ASYNC_BLOCKING: 'asyncBlocking',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnResponseStartedOptions: {
        RESPONSE_HEADERS: 'responseHeaders',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnBeforeRedirectOptions: {
        RESPONSE_HEADERS: 'responseHeaders',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnCompletedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnErrorOccurredOptions: { EXTRA_HEADERS: 'extraHeaders' },
      IgnoredActionType: {
        REDIRECT: 'redirect',
        REQUEST_HEADERS: 'request_headers',
        RESPONSE_HEADERS: 'response_headers',
        AUTH_CREDENTIALS: 'auth_credentials'
      }
    },
    permissions: ['webRequest', 'webRequestBlocking'],
    eventStyle: 'webRequest'
  }
}

/**
 * The `webRequest` registration calls the shim makes on behalf of an event's `addListener` /
 * `removeListener`: not members of `chrome.webRequest`, but routed like one.
 */
export const WEB_REQUEST_INTERNAL_METHODS = ['addListener', 'removeListener'] as const

/** Storage areas the host implements; the engine's `local` and `session` stay native for data. */
export const STORAGE_AREAS = ['local', 'sync', 'session', 'managed'] as const

/** Storage methods routed to the host for host-backed areas. */
export const STORAGE_METHODS = [
  'get',
  'set',
  'remove',
  'clear',
  'getBytesInUse',
  'getKeys',
  'setAccessLevel'
] as const

/** Whether a call names a member of the table (the router refuses everything else). */
export function isSpecMethod(spec: ApiSpec, namespace: string, method: string): boolean {
  const ns = spec[namespace]
  return Boolean(ns && Object.prototype.hasOwnProperty.call(ns.methods, method))
}
