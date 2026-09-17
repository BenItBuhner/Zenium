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
   * layer does not implement yet, so an extension that touches it while starting runs on.
   * `value` goes to the callback or promise; `id` answers with the caller's own id (a string
   * first argument or `createProperties.id`) or a generated one of that type; `sync` also returns
   * the id synchronously (`contextMenus.create`). Browser layer part 2 turns these into routed
   * calls by deleting the flag and adding the host handler.
   */
  inert?: { value?: unknown; id?: 'number' | 'string'; sync?: boolean }
}

export interface EventSpec {
  /** Documents keep receiving this event from the engine; the shim only adds the host's deliveries. */
  nativeInFrames?: boolean
  keepNative?: boolean
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

  // Browser layer part 2 namespaces, as shapes. Electron 44 has none of them, and of the top 30
  // Chrome Web Store extensions 15 register a webNavigation listener, 13 a contextMenus one, 11
  // commands.onCommand, 9 touch cookies and 7 notifications – at the top of their background
  // script, where an undefined namespace ends the extension before it does anything else.
  // Events never fire and methods answer with Chrome's empty results until part 2 lands.
  webNavigation: {
    shape: true,
    methods: {
      getFrame: { params: [object('details')], inert: { value: null } },
      getAllFrames: { params: [object('details')], inert: { value: [] } }
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
    shape: true,
    methods: {
      create: { params: [object('createProperties')], inert: { id: 'number', sync: true } },
      update: {
        params: [{ name: 'id', type: ['integer', 'string'] }, object('updateProperties')],
        inert: {}
      },
      remove: { params: [{ name: 'menuItemId', type: ['integer', 'string'] }], inert: {} },
      removeAll: { params: [], inert: {} }
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
    shape: true,
    methods: { getAll: { params: [], inert: { value: [] } } },
    events: { onCommand: {} }
  },
  notifications: {
    shape: true,
    methods: {
      create: {
        params: [{ name: 'notificationId', type: 'string', optional: true }, object('options')],
        inert: { id: 'string' }
      },
      update: { params: [string('notificationId'), object('options')], inert: { value: false } },
      clear: { params: [string('notificationId')], inert: { value: false } },
      getAll: { params: [], inert: { value: {} } },
      getPermissionLevel: { params: [], inert: { value: 'denied' } }
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
    shape: true,
    methods: {
      get: { params: [object('details')], inert: { value: null } },
      getAll: { params: [object('details')], inert: { value: [] } },
      set: { params: [object('details')], inert: { value: null } },
      remove: { params: [object('details')], inert: { value: null } },
      getAllCookieStores: { params: [], inert: { value: [] } },
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
  }
}

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
