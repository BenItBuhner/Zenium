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
import {
  CONTENT_SETTING_METHODS,
  CONTENT_SETTING_TYPES,
  CONTENT_SETTING_TYPE_NAMES
} from './contentSettings'
import { OFFSCREEN_PERMISSION, OFFSCREEN_REASON_CONSTANTS } from './offscreen'
import { PRIVACY_METHODS, PRIVACY_SETTING_NAMES } from './privacy'
import { PROXY_SETTING } from './proxy'
import { SYSTEM_DISPLAY_PERMISSION } from './systemDisplay'
import { SYSTEM_STORAGE_CONSTANTS, SYSTEM_STORAGE_PERMISSION } from './systemStorage'
import {
  DESKTOP_CAPTURE_PERMISSION,
  DESKTOP_CAPTURE_SOURCE_TYPE_CONSTANTS,
  TAB_CAPTURE_PERMISSION,
  TAB_CAPTURE_STATE_CONSTANTS
} from './tabCapture'
import { USER_SCRIPTS_UNAVAILABLE_ERROR } from './userScripts'

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
   * the id synchronously; `error` fails the call instead (`runtime.lastError` for a callback, a
   * rejection for a promise), the way Chrome reports a service that is off. Turning one into a
   * routed call is deleting the flag and adding the host handler.
   */
  inert?: { value?: unknown; id?: 'number' | 'string'; sync?: boolean; error?: string }
}

export interface EventSpec {
  /** Documents keep receiving this event from the engine; the shim only adds the host's deliveries. */
  nativeInFrames?: boolean
  keepNative?: boolean
  /**
   * The event exists only for extensions declaring one of these permissions
   * (`runtime.onUserScriptMessage` needs `userScripts`), like `NamespaceSpec.permissions`.
   */
  permissions?: readonly string[]
  /**
   * Chromium's `supportsFilters`: `addListener(callback, filters)` takes `events.UrlFilter`s
   * under `filters.url` (`webNavigation`), validated on registration. Every other event ignores
   * a second argument, whatever it is, as Chromium's binding does (Violentmonkey passes `false`
   * to `tabs.onUpdated`).
   */
  filters?: boolean
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
   * manifest lists one of these permissions, required or optional (the engine's own namespace,
   * when it made one, is patched regardless). Declaring is what counts, not the grant: Chrome
   * leaves an optional namespace undefined until `permissions.request` grants it and defines it
   * then; the shim has no synchronous view of the granted set at start-up, so a declared optional
   * namespace exists (and answers) from the first statement. Extensions written for Chrome test
   * `chrome.tabGroups ?` before asking, and get the working namespace either way.
   */
  permissions?: readonly string[]
  /**
   * `webRequest`: the events take `(callback, RequestFilter filter, extraInfoSpec)` instead of
   * Chrome's generic `(callback, filters)`, and a delivery to a `blocking` listener carries a
   * token the shim answers with the listener's return value. The shim builds these events
   * itself from `EventSpec.extraInfoSpec`.
   */
  eventStyle?: 'webRequest'
  /**
   * `privacy`: the namespace's members are objects (`network`, `websites`, …) of
   * `types.ChromeSetting`s, each with `get` / `set` / `clear` and an `onChange` event. The shim
   * builds them from this map of object name to setting names and routes the calls as
   * `<namespace>.<method>(object, setting, details)`; the host fires
   * `<namespace>.<object>.<setting>.onChange`.
   */
  settings?: Readonly<Record<string, readonly string[]>>
  /**
   * `proxy`: `types.ChromeSetting`s that are members of the namespace itself (`proxy.settings`),
   * routed as `<namespace>.<method>(setting, details)`; the host fires
   * `<namespace>.<setting>.onChange`. The engine's inert copy of the member is replaced.
   */
  ownSettings?: readonly string[]
  /**
   * `contentSettings`: `contentSettings.ContentSetting`s that are members of the namespace
   * (`contentSettings.cookies`, `contentSettings.javascript`, …), each with `get` / `set` /
   * `clear` / `getResourceIdentifiers` and no event, routed as `<namespace>.<method>(type,
   * details)`.
   */
  contentSettings?: readonly string[]
  /**
   * `userScripts`: Chrome hides the namespace behind a per-extension toggle ("Allow user
   * scripts"). While `ShimOptions.toggles[key]` is false, reading `chrome.<namespace>` throws
   * `error` (extensions feature-detect it with `try { chrome.userScripts } catch {}`); the host
   * pushes the toggle's changes (`__zen.toggles`) and the shim installs or removes the namespace
   * then. Without a `toggles` option the namespace is simply there (emulated engines).
   */
  toggle?: { key: string; error: string }
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

/** Chrome's names for the value enums of `contentSettings` where they differ from the type's. */
const CONTENT_SETTING_ENUM_NAMES: Readonly<Record<string, string>> = {
  unsandboxedPlugins: 'PpapiBrokerContentSetting',
  automaticDownloads: 'MultipleAutomaticDownloadsContentSetting'
}

/** `contentSettings.CookiesContentSetting = { ALLOW, BLOCK, SESSION_ONLY }` and the like. */
function contentSettingEnums(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const type of CONTENT_SETTING_TYPES) {
    const name =
      CONTENT_SETTING_ENUM_NAMES[type.name] ??
      `${type.name[0].toUpperCase()}${type.name.slice(1)}ContentSetting`
    out[name] = Object.fromEntries(type.values.map((value) => [value.toUpperCase(), value]))
  }
  return out
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
      getSelected: { params: [integer('windowId', true)] },
      group: { params: [object('options')] },
      ungroup: { params: [{ name: 'tabIds', type: ['integer', 'array'] }] }
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
      setUninstallURL: { params: [string('url')] },
      getContexts: { params: [object('filter')] }
    },
    events: {
      onInstalled: {},
      onStartup: {},
      // A user-script world's `runtime.sendMessage` / `runtime.connect` arrive here, not on
      // `onMessage` / `onConnect`; the shim builds the `sendResponse` and the `Port` (see `shim.ts`).
      onUserScriptMessage: { permissions: ['userScripts'] },
      onUserScriptConnect: { permissions: ['userScripts'] }
    },
    constants: {
      ContextType: {
        TAB: 'TAB',
        POPUP: 'POPUP',
        BACKGROUND: 'BACKGROUND',
        OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT',
        SIDE_PANEL: 'SIDE_PANEL',
        DEVELOPER_TOOLS: 'DEVELOPER_TOOLS'
      }
    }
  },
  // `onUserSettingsChanged` (Chrome 130) is `action`'s alone: the toolbar pin of an MV2
  // `browserAction` has no event. Zenium pins every action, so it exists and never fires (Meta
  // Ads Data Advisor's worker init dereferences it before its side panel behaviour).
  action: {
    methods: ACTION_METHODS,
    events: { onClicked: {}, onUserSettingsChanged: {} },
    manifestVersion: 3
  },
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
      onBeforeNavigate: { filters: true },
      onCommitted: { filters: true },
      onDOMContentLoaded: { filters: true },
      onCompleted: { filters: true },
      onErrorOccurred: { filters: true },
      onCreatedNavigationTarget: { filters: true },
      onReferenceFragmentUpdated: { filters: true },
      onTabReplaced: { filters: true },
      onHistoryStateUpdated: { filters: true }
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

  // Browser layer part 3: bridges onto Zenium's own models. Every member routes to the host,
  // which reads and writes the model through its service and fires the events from a diff of
  // the model's commits.
  bookmarks: {
    methods: {
      get: { params: [{ name: 'idOrIdList', type: ['string', 'array'] }] },
      getChildren: { params: [string('id')] },
      getRecent: { params: [integer('numberOfItems')] },
      getTree: { params: [] },
      getSubTree: { params: [string('id')] },
      search: { params: [{ name: 'query', type: ['string', 'object'] }] },
      create: { params: [object('bookmark')] },
      move: { params: [string('id'), object('destination')] },
      update: { params: [string('id'), object('changes')] },
      remove: { params: [string('id')] },
      removeTree: { params: [string('id')] }
    },
    events: {
      onCreated: {},
      onRemoved: {},
      onChanged: {},
      onMoved: {},
      onChildrenReordered: {},
      onImportBegan: {},
      onImportEnded: {}
    },
    constants: {
      MAX_WRITE_OPERATIONS_PER_HOUR: 1000000,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
      BookmarkTreeNodeUnmodifiable: { MANAGED: 'managed' },
      FolderType: {
        BOOKMARKS_BAR: 'bookmarks-bar',
        OTHER: 'other',
        MOBILE: 'mobile',
        MANAGED: 'managed'
      }
    },
    permissions: ['bookmarks']
  },
  history: {
    methods: {
      search: { params: [object('query')] },
      getVisits: { params: [object('details')] },
      addUrl: { params: [object('details')] },
      deleteUrl: { params: [object('details')] },
      deleteRange: { params: [object('range')] },
      deleteAll: { params: [] }
    },
    events: { onVisited: {}, onVisitRemoved: {} },
    constants: {
      TransitionType: {
        LINK: 'link',
        TYPED: 'typed',
        AUTO_BOOKMARK: 'auto_bookmark',
        AUTO_SUBFRAME: 'auto_subframe',
        MANUAL_SUBFRAME: 'manual_subframe',
        GENERATED: 'generated',
        AUTO_TOPLEVEL: 'auto_toplevel',
        FORM_SUBMIT: 'form_submit',
        RELOAD: 'reload',
        KEYWORD: 'keyword',
        KEYWORD_GENERATED: 'keyword_generated'
      }
    },
    permissions: ['history']
  },
  downloads: {
    methods: {
      download: { params: [object('options')] },
      search: { params: [object('query')] },
      pause: { params: [integer('downloadId')] },
      resume: { params: [integer('downloadId')] },
      cancel: { params: [integer('downloadId')] },
      getFileIcon: { params: [integer('downloadId'), object('options', true)] },
      open: { params: [integer('downloadId')] },
      show: { params: [integer('downloadId')] },
      showDefaultFolder: { params: [] },
      erase: { params: [object('query')] },
      removeFile: { params: [integer('downloadId')] },
      acceptDanger: { params: [integer('downloadId')] },
      setUiOptions: { params: [object('options')] },
      setShelfEnabled: { params: [boolean('enabled')] }
    },
    events: { onCreated: {}, onErased: {}, onChanged: {}, onDeterminingFilename: {} },
    constants: {
      FilenameConflictAction: { UNIQUIFY: 'uniquify', OVERWRITE: 'overwrite', PROMPT: 'prompt' },
      State: { IN_PROGRESS: 'in_progress', INTERRUPTED: 'interrupted', COMPLETE: 'complete' },
      DangerType: {
        FILE: 'file',
        URL: 'url',
        CONTENT: 'content',
        UNCOMMON: 'uncommon',
        HOST: 'host',
        UNWANTED: 'unwanted',
        SAFE: 'safe',
        ACCEPTED: 'accepted',
        ALLOWLISTED_BY_POLICY: 'allowlistedByPolicy',
        ASYNC_SCANNING: 'asyncScanning',
        ASYNC_LOCAL_PASSWORD_SCANNING: 'asyncLocalPasswordScanning',
        PASSWORD_PROTECTED: 'passwordProtected',
        BLOCKED_TOO_LARGE: 'blockedTooLarge',
        SENSITIVE_CONTENT_WARNING: 'sensitiveContentWarning',
        SENSITIVE_CONTENT_BLOCK: 'sensitiveContentBlock',
        DEEP_SCANNED_FAILED: 'deepScannedFailed',
        DEEP_SCANNED_SAFE: 'deepScannedSafe',
        DEEP_SCANNED_OPENED_DANGEROUS: 'deepScannedOpenedDangerous',
        PROMPT_FOR_SCANNING: 'promptForScanning',
        PROMPT_FOR_LOCAL_PASSWORD_SCANNING: 'promptForLocalPasswordScanning',
        ACCOUNT_COMPROMISE: 'accountCompromise',
        BLOCKED_SCAN_FAILED: 'blockedScanFailed'
      },
      InterruptReason: {
        FILE_FAILED: 'FILE_FAILED',
        FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
        FILE_NO_SPACE: 'FILE_NO_SPACE',
        FILE_NAME_TOO_LONG: 'FILE_NAME_TOO_LONG',
        FILE_TOO_LARGE: 'FILE_TOO_LARGE',
        FILE_VIRUS_INFECTED: 'FILE_VIRUS_INFECTED',
        FILE_TRANSIENT_ERROR: 'FILE_TRANSIENT_ERROR',
        FILE_BLOCKED: 'FILE_BLOCKED',
        FILE_SECURITY_CHECK_FAILED: 'FILE_SECURITY_CHECK_FAILED',
        FILE_TOO_SHORT: 'FILE_TOO_SHORT',
        FILE_HASH_MISMATCH: 'FILE_HASH_MISMATCH',
        FILE_SAME_AS_SOURCE: 'FILE_SAME_AS_SOURCE',
        NETWORK_FAILED: 'NETWORK_FAILED',
        NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
        NETWORK_DISCONNECTED: 'NETWORK_DISCONNECTED',
        NETWORK_SERVER_DOWN: 'NETWORK_SERVER_DOWN',
        NETWORK_INVALID_REQUEST: 'NETWORK_INVALID_REQUEST',
        SERVER_FAILED: 'SERVER_FAILED',
        SERVER_NO_RANGE: 'SERVER_NO_RANGE',
        SERVER_BAD_CONTENT: 'SERVER_BAD_CONTENT',
        SERVER_UNAUTHORIZED: 'SERVER_UNAUTHORIZED',
        SERVER_CERT_PROBLEM: 'SERVER_CERT_PROBLEM',
        SERVER_FORBIDDEN: 'SERVER_FORBIDDEN',
        SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
        SERVER_CONTENT_LENGTH_MISMATCH: 'SERVER_CONTENT_LENGTH_MISMATCH',
        SERVER_CROSS_ORIGIN_REDIRECT: 'SERVER_CROSS_ORIGIN_REDIRECT',
        USER_CANCELED: 'USER_CANCELED',
        USER_SHUTDOWN: 'USER_SHUTDOWN',
        CRASH: 'CRASH'
      }
    },
    permissions: ['downloads']
  },
  sessions: {
    methods: {
      getRecentlyClosed: { params: [object('filter', true)] },
      getDevices: { params: [object('filter', true)] },
      restore: { params: [string('sessionId', true)] }
    },
    events: { onChanged: {} },
    constants: { MAX_SESSION_RESULTS: 25 },
    permissions: ['sessions']
  },
  topSites: {
    methods: { get: { params: [] } },
    events: {},
    permissions: ['topSites']
  },
  // The engine makes the namespace but has no display provider behind it (every call fails with
  // "System display API is not available."): `getInfo` answers from the browser's screens as
  // Chrome does on Windows, macOS and Linux, `getDisplayLayout` is empty there, and the functions
  // Chrome restricts to ChromeOS fail with its error. `onDisplayChanged` follows the screens.
  'system.display': {
    methods: {
      getInfo: { params: [object('flags', true)] },
      getDisplayLayout: { params: [] },
      setDisplayProperties: { params: [string('id'), object('info')] },
      setDisplayLayout: { params: [{ name: 'layouts', type: 'array' }] },
      enableUnifiedDesktop: { params: [boolean('enabled')] },
      overscanCalibrationStart: { params: [string('id')] },
      overscanCalibrationAdjust: { params: [string('id'), object('delta')] },
      overscanCalibrationReset: { params: [string('id')] },
      overscanCalibrationComplete: { params: [string('id')] },
      showNativeTouchCalibration: { params: [string('id')] },
      startCustomTouchCalibration: { params: [string('id')] },
      completeCustomTouchCalibration: {
        params: [{ name: 'pairs', type: 'object' }, object('bounds')]
      },
      clearTouchCalibration: { params: [string('id')] },
      setMirrorMode: { params: [object('info')] }
    },
    events: { onDisplayChanged: {} },
    constants: {
      ActiveState: { ACTIVE: 'active', INACTIVE: 'inactive' },
      LayoutPosition: { TOP: 'top', RIGHT: 'right', BOTTOM: 'bottom', LEFT: 'left' },
      MirrorMode: { OFF: 'off', NORMAL: 'normal', MIXED: 'mixed' }
    },
    permissions: [SYSTEM_DISPLAY_PERMISSION]
  },
  // The engine's own namespace crashes the browser (Electron never instantiates the
  // `StorageMonitor` its functions dereference), so the permission is withheld from the manifest
  // the engine loads (`core/extensions/withheldPermissions.ts`) and the browser layer answers in
  // Chrome's shape over no devices: nothing to list, no capacity for an unknown id, nothing to
  // eject; the events exist and never fire. For extensions declaring the permission only.
  'system.storage': {
    methods: {
      getInfo: { params: [] },
      getAvailableCapacity: { params: [string('id')] },
      ejectDevice: { params: [string('id')] }
    },
    events: { onAttached: {}, onDetached: {} },
    constants: SYSTEM_STORAGE_CONSTANTS,
    permissions: [SYSTEM_STORAGE_PERMISSION]
  },
  // The keyword comes from the manifest; the URL bar asks through `onInputChanged(text, suggest)`.
  omnibox: {
    methods: {
      setDefaultSuggestion: { params: [object('suggestion')] }
    },
    events: {
      onInputStarted: {},
      onInputChanged: {},
      onInputEntered: {},
      onInputCancelled: {},
      onDeleteSuggestion: {}
    },
    constants: {
      DescriptionStyleType: { URL: 'url', MATCH: 'match', DIM: 'dim' },
      OnInputEnteredDisposition: {
        CURRENT_TAB: 'currentTab',
        NEW_FOREGROUND_TAB: 'newForegroundTab',
        NEW_BACKGROUND_TAB: 'newBackgroundTab'
      }
    }
  },
  // Only the web-auth flow has anything to stand on: there is no signed-in browser account.
  identity: {
    methods: {
      getRedirectURL: { params: [{ name: 'details', type: ['object', 'string'], optional: true }] },
      launchWebAuthFlow: { params: [object('details')] },
      getProfileUserInfo: { params: [object('details', true)] },
      getAuthToken: { params: [object('details', true)] },
      removeCachedAuthToken: { params: [object('details')] },
      clearAllCachedAuthTokens: { params: [] },
      getAccounts: { params: [] }
    },
    events: { onSignInChanged: {} },
    constants: {
      AccountStatus: { SYNC: 'SYNC', ANY: 'ANY' }
    },
    permissions: ['identity']
  },
  // Per-site content settings as rules of an extension (patterns, a value, a scope), one
  // `ContentSetting` object per type; the rules rank above the user's own answers in the
  // permission store, as Chrome's extension provider does. The enum constants are Chrome's
  // (`Scope`, and one `<Type>ContentSetting` per type with its values).
  contentSettings: {
    methods: {},
    events: {},
    contentSettings: CONTENT_SETTING_TYPE_NAMES,
    constants: {
      Scope: { REGULAR: 'regular', INCOGNITO_SESSION_ONLY: 'incognito_session_only' },
      ...contentSettingEnums()
    },
    permissions: ['contentSettings']
  },
  // A DevTools protocol session on a tab over the engine's per-page debugger: Chrome's rules on
  // who may attach to what, one extension per tab, `onEvent` for the protocol's notifications
  // (with the `sessionId` of a flattened child target), `onDetach` when the tab goes or the
  // session is taken away. Chrome's "is debugging this browser" bar has no counterpart yet.
  debugger: {
    methods: {
      attach: { params: [object('target'), string('requiredVersion')] },
      detach: { params: [object('target')] },
      sendCommand: {
        params: [object('target'), string('method'), object('commandParams', true)]
      },
      getTargets: { params: [] }
    },
    events: { onEvent: {}, onDetach: {} },
    constants: {
      DetachReason: { TARGET_CLOSED: 'target_closed', CANCELED_BY_USER: 'canceled_by_user' },
      TargetInfoType: {
        PAGE: 'page',
        BACKGROUND_PAGE: 'background_page',
        WORKER: 'worker',
        OTHER: 'other'
      }
    },
    permissions: ['debugger']
  },
  // Firebase Cloud Messaging through Chrome's own device channel (Chrome's GCM client registers
  // the browser with Google under Chrome's credentials), which no other browser has: the
  // namespace is the shape Chrome shows a profile with GCM off. `register`, `unregister` and
  // `send` fail with Chrome's `GCM_DISABLED`; the events exist and never fire (Read&Write
  // registers `onMessage` at start-up and runs on).
  gcm: {
    methods: {
      register: {
        params: [{ name: 'senderIds', type: 'array' }],
        inert: { error: 'GCM_DISABLED' }
      },
      unregister: { params: [], inert: { error: 'GCM_DISABLED' } },
      send: { params: [object('message')], inert: { error: 'GCM_DISABLED' } }
    },
    events: { onMessage: {}, onMessagesDeleted: {}, onSendError: {} },
    constants: { MAX_MESSAGE_SIZE: 4096 },
    shape: true,
    permissions: ['gcm']
  },
  // A print destination the extension provides to Chrome's print preview: four events the
  // browser raises from its print dialog, no methods. Zenium's print dialog is the engine's own
  // and asks no extension for printers yet, so the events exist and never fire; the namespace
  // is the shape Chrome has once the permission is declared (Save to Google Drive registers all
  // three of its listeners in its worker's constructor, and a missing namespace ended it there).
  printerProvider: {
    methods: {},
    events: {
      onGetPrintersRequested: {},
      onGetUsbPrinterInfoRequested: {},
      onGetCapabilityRequested: {},
      onPrintRequested: {}
    },
    shape: true,
    permissions: ['printerProvider']
  },
  // Chrome exposes `instanceID` with the `gcm` permission. The ID itself is local (Chrome
  // generates it without the server), so `getID` is stable per install, `getCreationTime` dates
  // it and `deleteID` drops it; tokens are GCM's, so `getToken` / `deleteToken` fail as Chrome's
  // Instance ID does with GCM off (WPS PDF watches `getID` from its popup and options).
  instanceID: {
    methods: {
      getID: { params: [] },
      getCreationTime: { params: [] },
      getToken: { params: [object('getTokenParams')] },
      deleteToken: { params: [object('deleteTokenParams')] },
      deleteID: { params: [] }
    },
    events: { onTokenRefresh: {} },
    permissions: ['gcm']
  },
  // The panel is Zenium's own view beside the page; the options follow Chrome's default-plus-per-tab
  // rules. `onOpened` / `onClosed` (Chrome 140 / 142) follow the view showing and going away;
  // `getLayout` reports the side the strip docks on.
  // Electron has the binding, but its `ExtensionHost` takes the browser down when the document
  // touches media devices (`core/extensions/api/offscreen.ts`): the browser layer hosts the
  // document itself and answers the namespace, the engine's copy replaced in place.
  offscreen: {
    methods: {
      createDocument: { params: [object('parameters')] },
      closeDocument: { params: [] },
      hasDocument: { params: [] }
    },
    events: {},
    constants: { Reason: OFFSCREEN_REASON_CONSTANTS },
    manifestVersion: 3,
    permissions: [OFFSCREEN_PERMISSION]
  },
  // Neither binding exists on Electron (its feature list is a subset of Chrome's). The stream
  // ids come from the engine's page capture; `capture` runs `getUserMedia` on the context side
  // as Chrome's binding does, so the shim replaces it there (`core/extensions/api/tabCapture.ts`).
  tabCapture: {
    methods: {
      capture: { params: [object('options')] },
      getCapturedTabs: { params: [] },
      getMediaStreamId: { params: [object('options', true)] }
    },
    events: { onStatusChanged: {} },
    constants: { TabCaptureState: TAB_CAPTURE_STATE_CONSTANTS },
    permissions: [TAB_CAPTURE_PERMISSION]
  },
  // `chooseDesktopMedia` answers its request id synchronously and its callback with the picker's
  // choice; Zenium has no picker for an extension's call yet, so the answer is Chrome's cancel
  // (an empty stream id). The shim shapes the call; the host checks the arguments.
  desktopCapture: {
    methods: {
      chooseDesktopMedia: {
        params: [{ name: 'sources', type: 'array' }, object('targetTab', true)]
      },
      cancelChooseDesktopMedia: { params: [integer('desktopMediaRequestId')] }
    },
    events: {},
    constants: { DesktopCaptureSourceType: DESKTOP_CAPTURE_SOURCE_TYPE_CONSTANTS },
    permissions: [DESKTOP_CAPTURE_PERMISSION]
  },
  sidePanel: {
    methods: {
      setOptions: { params: [object('options')] },
      getOptions: { params: [object('options', true)] },
      setPanelBehavior: { params: [object('behavior')] },
      getPanelBehavior: { params: [] },
      open: { params: [object('options')] },
      close: { params: [object('options')] },
      getLayout: { params: [] }
    },
    events: { onOpened: {}, onClosed: {} },
    constants: { Side: { LEFT: 'left', RIGHT: 'right' } },
    permissions: ['sidePanel']
  },
  // Electron has the binding, but the session's own `webRequest` hook (the blocking engine's)
  // switches the engine's extension path off, so the events never fire. The emulation runs the
  // listeners over the same hook (`main/platform/webRequest.ts`): registrations go to the host
  // through the internal `addListener` / `removeListener` calls, deliveries come back addressed
  // to the listener, and a blocking listener's return value travels back as the answer.
  // `onAuthRequired` runs off the engine's `login` event instead (a challenge is not a hook of
  // the session pipeline); its blocking answer carries `authCredentials` or `cancel`.
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
  },
  // Absent from Electron altogether (Chrome's preference service is not part of the engine),
  // and probed at start-up by uBlock Origin and Privacy Badger. The settings live in the host
  // (`core/extensions/api/privacy.ts` has the table and Chrome's precedence rules); the ones
  // Zenium can act on are applied to the pages and the request pipeline, the rest are
  // remembered and reported back.
  privacy: {
    methods: {},
    events: {},
    constants: {
      IPHandlingPolicy: {
        DEFAULT: 'default',
        DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: 'default_public_and_private_interfaces',
        DEFAULT_PUBLIC_INTERFACE_ONLY: 'default_public_interface_only',
        DISABLE_NON_PROXIED_UDP: 'disable_non_proxied_udp'
      }
    },
    permissions: ['privacy'],
    settings: PRIVACY_SETTING_NAMES
  },
  // Electron's binding defines `proxy.settings` but its calls reject ("Access to extension API
  // denied.": Chrome's preference service is not part of the engine). The setting lives in the
  // host (`core/extensions/api/proxy.ts` has Chrome's checks and the config's canonical form,
  // the precedence rules are `privacy`'s) and is applied to the sessions through Electron's
  // `setProxy`; `onProxyError` reports a configuration the sessions refused.
  proxy: {
    methods: {},
    events: { onProxyError: {} },
    constants: {
      Mode: {
        DIRECT: 'direct',
        AUTO_DETECT: 'auto_detect',
        PAC_SCRIPT: 'pac_script',
        FIXED_SERVERS: 'fixed_servers',
        SYSTEM: 'system'
      },
      Scheme: {
        HTTP: 'http',
        HTTPS: 'https',
        QUIC: 'quic',
        SOCKS4: 'socks4',
        SOCKS5: 'socks5'
      }
    },
    permissions: ['proxy'],
    ownSettings: [PROXY_SETTING]
  },
  // Site storage and the cache through the engine's sessions, history and downloads through the models.
  browsingData: {
    methods: {
      settings: { params: [] },
      remove: { params: [object('options'), object('dataToRemove')] },
      removeAppcache: { params: [object('options')] },
      removeCache: { params: [object('options')] },
      removeCacheStorage: { params: [object('options')] },
      removeCookies: { params: [object('options')] },
      removeDownloads: { params: [object('options')] },
      removeFileSystems: { params: [object('options')] },
      removeFormData: { params: [object('options')] },
      removeHistory: { params: [object('options')] },
      removeIndexedDB: { params: [object('options')] },
      removeLocalStorage: { params: [object('options')] },
      removePasswords: { params: [object('options')] },
      removePluginData: { params: [object('options')] },
      removeServiceWorkers: { params: [object('options')] },
      removeWebSQL: { params: [object('options')] }
    },
    events: {},
    permissions: ['browsingData']
  },
  // Speech through a hidden page's `speechSynthesis`; `speak`'s `onEvent` is relayed by the shim.
  tts: {
    methods: {
      speak: { params: [string('utterance'), object('options', true)] },
      stop: { params: [] },
      pause: { params: [] },
      resume: { params: [] },
      isSpeaking: { params: [] },
      getVoices: { params: [] }
    },
    events: { onVoicesChanged: {} },
    constants: {
      EventType: {
        START: 'start',
        END: 'end',
        WORD: 'word',
        SENTENCE: 'sentence',
        MARKER: 'marker',
        INTERRUPTED: 'interrupted',
        CANCELLED: 'cancelled',
        ERROR: 'error',
        PAUSE: 'pause',
        RESUME: 'resume'
      },
      VoiceGender: { MALE: 'male', FEMALE: 'female' }
    },
    permissions: ['tts']
  },
  // Absent from Electron (Chrome's user-script worlds are the extension system's). The host
  // keeps the registrations (`core/extensions/api/userScripts.ts` has the model) and runs them
  // through the page preload in every frame: `USER_SCRIPT` registrations in an isolated world of
  // their own per extension and `worldId`, `MAIN` ones in the page's world. A world with
  // `messaging` on gets `runtime.sendMessage` / `runtime.connect`, which arrive on
  // `runtime.onUserScriptMessage` / `onUserScriptConnect`; `tabs.sendMessage` reaches the
  // worlds' `runtime.onMessage` through the internal `sendMessage` call (see `shim.ts`).
  userScripts: {
    methods: {
      register: { params: [{ name: 'scripts', type: 'array' }] },
      getScripts: { params: [object('filter', true)] },
      unregister: { params: [object('filter', true)] },
      update: { params: [{ name: 'scripts', type: 'array' }] },
      configureWorld: { params: [object('properties')] },
      getWorldConfigurations: { params: [] },
      resetWorldConfiguration: { params: [string('worldId', true)] },
      execute: { params: [object('injection')] }
    },
    events: {},
    constants: { ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' } },
    permissions: ['userScripts'],
    toggle: { key: 'userScripts', error: USER_SCRIPTS_UNAVAILABLE_ERROR }
  },
  // Zenium's folders are the groups; `tabs.group` / `tabs.ungroup` are declared on `tabs`.
  tabGroups: {
    methods: {
      get: { params: [integer('groupId')] },
      query: { params: [object('queryInfo')] },
      update: { params: [integer('groupId'), object('updateProperties')] },
      move: { params: [integer('groupId'), object('moveProperties')] }
    },
    events: { onCreated: {}, onUpdated: {}, onMoved: {}, onRemoved: {} },
    constants: {
      TAB_GROUP_ID_NONE: -1,
      Color: {
        GREY: 'grey',
        BLUE: 'blue',
        RED: 'red',
        YELLOW: 'yellow',
        GREEN: 'green',
        PINK: 'pink',
        PURPLE: 'purple',
        CYAN: 'cyan',
        ORANGE: 'orange'
      }
    },
    permissions: ['tabGroups']
  }
}

/**
 * The `webRequest` registration calls the shim makes on behalf of an event's `addListener` /
 * `removeListener`: not members of `chrome.webRequest`, but routed like one.
 */
export const WEB_REQUEST_INTERNAL_METHODS = ['addListener', 'removeListener'] as const

/**
 * The calls the shim makes on behalf of a `privacy` setting object's `get` / `set` / `clear`:
 * not members of `chrome.privacy`, but routed like one (with the setting's names first).
 */
export const PRIVACY_INTERNAL_METHODS = PRIVACY_METHODS

/**
 * The calls the shim makes on behalf of `proxy.settings`' `get` / `set` / `clear`: not members
 * of `chrome.proxy`, but routed like one (with the setting's name first).
 */
export const PROXY_INTERNAL_METHODS = PRIVACY_METHODS

/**
 * The calls the shim makes on behalf of a `contentSettings.<type>` object's `get` / `set` /
 * `clear` / `getResourceIdentifiers`: not members of `chrome.contentSettings`, but routed like
 * one (with the type's name first).
 */
export const CONTENT_SETTINGS_INTERNAL_METHODS = CONTENT_SETTING_METHODS

/**
 * The call the shim makes on behalf of `tabs.sendMessage` for an extension holding
 * `userScripts`: the delivery to the tab's user-script worlds, beside the engine's own delivery
 * to the content scripts. Not a member of `chrome.userScripts`, but routed like one.
 */
export const USER_SCRIPTS_INTERNAL_METHODS = ['sendMessage'] as const

/**
 * The calls the shim makes around a consuming document's `getUserMedia` for `tabCapture`
 * (`core/extensions/api/tabCapture.ts`): the engine's id for a stream id this layer answered,
 * and the state the call reached. Not members of `chrome.tabCapture`, but routed like ones.
 */
export { TAB_CAPTURE_INTERNAL_METHODS } from './tabCapture'

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

/**
 * The shim's own calls for the content-script storage prelude (not members of `chrome.storage`):
 * `syncWrite(op, args)` commits a content script's proxied `sync` write and answers with the
 * change and its sequence number; `syncMirror()` is the snapshot a context starts its
 * partition's mirror from.
 */
export const STORAGE_INTERNAL_METHODS = ['syncWrite', 'syncMirror'] as const

/** Whether a call names a member of the table (the router refuses everything else). */
export function isSpecMethod(spec: ApiSpec, namespace: string, method: string): boolean {
  const ns = spec[namespace]
  return Boolean(ns && Object.prototype.hasOwnProperty.call(ns.methods, method))
}
