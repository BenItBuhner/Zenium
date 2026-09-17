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
