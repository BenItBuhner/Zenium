/**
 * The `chrome.*` members Chromium's engine provides natively, for hosts whose engine is
 * emulated: Zenium for Android runs extensions on the system WebView, which has no extension
 * system at all, so the browser layer's table (`spec.ts`, everything Electron lacks) is only
 * half of what an extension finds on `chrome`. This is the other half, in the same format, so
 * `installExtensionApi` builds both from one merged table (`engineApiSpec`).
 *
 * Members the emulated engine answers on the context side (`engine.ts`: `runtime.getURL`,
 * `runtime.sendMessage`, ports, `i18n.getMessage`, …) are `keepNative`: the engine defines them
 * before the shim runs, and the shim leaves them alone exactly as it leaves Electron's bindings.
 * Everything else routes to the host, which answers, rejects with a clear "not implemented on
 * Zenium for Android" error (`stub`), or resolves quietly after one console warning (`noop`,
 * for setters extensions call while starting up: `ENGINE_NOOPS`).
 *
 * Namespaces are gated like Chrome gates them: by the permission they need
 * (`NAMESPACE_PERMISSIONS`), by manifest version, and content scripts only get the handful
 * Chrome exposes there (`CONTENT_SCRIPT_NAMESPACES`).
 */
import { API_SPEC, type ApiSpec, type MethodSpec, type NamespaceSpec, type ParamSpec } from './spec'

const integer = (name: string, optional = false): ParamSpec => ({ name, type: 'integer', optional })
const object = (name: string, optional = false): ParamSpec => ({ name, type: 'object', optional })
const string = (name: string, optional = false): ParamSpec => ({ name, type: 'string', optional })
const array = (name: string, optional = false): ParamSpec => ({ name, type: 'array', optional })
const any = (name: string, optional = true): ParamSpec => ({ name, type: 'any', optional })

/** A routed method; the host answers or rejects. */
const routed = (...params: ParamSpec[]): MethodSpec => ({ params })
/** A member `engine.ts` defines on the context side before the shim runs. */
const engine = (...params: ParamSpec[]): MethodSpec => ({ params, keepNative: true })
/** A member the host has no implementation for: routed, so the rejection carries the member's name. */
const stub = (...params: ParamSpec[]): MethodSpec => ({
  params: params.length > 0 ? params : [any('details'), any('options')]
})

const PAGE_ACTION_METHODS: Record<string, MethodSpec> = {
  show: routed(integer('tabId')),
  hide: routed(integer('tabId')),
  setTitle: routed(object('details')),
  getTitle: routed(object('details')),
  setIcon: routed(object('details')),
  setPopup: routed(object('details')),
  getPopup: routed(object('details'))
}

export const ENGINE_SPEC: ApiSpec = {
  runtime: {
    methods: {
      getURL: engine(string('path')),
      getManifest: engine(),
      getPlatformInfo: engine(),
      sendMessage: engine(any('extensionId'), any('message'), object('options', true)),
      connect: engine(any('extensionId'), object('connectInfo', true)),
      reload: routed(),
      getContexts: routed(object('filter')),
      requestUpdateCheck: routed(),
      getBackgroundPage: routed(),
      sendNativeMessage: routed(string('application'), object('message')),
      connectNative: routed(string('application')),
      restart: routed(),
      restartAfterDelay: routed(integer('seconds')),
      getPackageDirectoryEntry: routed()
    },
    events: {
      onMessage: { keepNative: true },
      onMessageExternal: { keepNative: true },
      onConnect: { keepNative: true },
      onConnectExternal: { keepNative: true },
      onUserScriptMessage: { keepNative: true },
      onUserScriptConnect: { keepNative: true },
      onSuspend: {},
      onSuspendCanceled: {},
      onUpdateAvailable: {},
      onRestartRequired: {}
    },
    constants: {
      OnInstalledReason: {
        INSTALL: 'install',
        UPDATE: 'update',
        CHROME_UPDATE: 'chrome_update',
        SHARED_MODULE_UPDATE: 'shared_module_update'
      },
      OnRestartRequiredReason: {
        APP_UPDATE: 'app_update',
        OS_UPDATE: 'os_update',
        PERIODIC: 'periodic'
      },
      PlatformOs: {
        MAC: 'mac',
        WIN: 'win',
        ANDROID: 'android',
        CROS: 'cros',
        LINUX: 'linux',
        OPENBSD: 'openbsd',
        FUCHSIA: 'fuchsia'
      },
      PlatformArch: {
        ARM: 'arm',
        ARM64: 'arm64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
        MIPS: 'mips',
        MIPS64: 'mips64'
      },
      PlatformNaclArch: {
        ARM: 'arm',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
        MIPS: 'mips',
        MIPS64: 'mips64'
      },
      RequestUpdateCheckStatus: {
        THROTTLED: 'throttled',
        NO_UPDATE: 'no_update',
        UPDATE_AVAILABLE: 'update_available'
      },
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
  i18n: {
    methods: {
      getMessage: engine(string('messageName'), any('substitutions'), object('options', true)),
      getUILanguage: engine(),
      getAcceptLanguages: engine(),
      detectLanguage: routed(string('text'))
    },
    events: {}
  },
  tabs: {
    methods: {
      sendMessage: engine(integer('tabId'), any('message'), object('options', true)),
      connect: engine(integer('tabId'), object('connectInfo', true)),
      /** MV2 `tabs.executeScript([tabId], details)`; the tab id defaults to the active tab. */
      executeScript: routed(integer('tabId', true), object('details')),
      getZoomSettings: routed(integer('tabId', true)),
      setZoomSettings: routed(integer('tabId', true), object('zoomSettings')),
      group: routed(object('options')),
      ungroup: routed({ name: 'tabIds', type: ['integer', 'array'] })
    },
    events: {},
    constants: {
      ZoomSettingsMode: { AUTOMATIC: 'automatic', MANUAL: 'manual', DISABLED: 'disabled' },
      ZoomSettingsScope: { PER_ORIGIN: 'per-origin', PER_TAB: 'per-tab' }
    }
  },
  pageAction: { methods: PAGE_ACTION_METHODS, events: { onClicked: {} }, manifestVersion: 2 },
  scripting: {
    methods: {
      /** `func` cannot cross the transport; the engine sends its source and the host wraps it. */
      executeScript: engine(object('injection')),
      insertCSS: routed(object('injection')),
      removeCSS: routed(object('injection')),
      registerContentScripts: routed(array('scripts')),
      getRegisteredContentScripts: routed(object('filter', true)),
      unregisterContentScripts: routed(object('filter', true)),
      updateContentScripts: routed(array('scripts'))
    },
    events: {},
    constants: { ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' } }
  },
  declarativeNetRequest: {
    methods: {
      updateDynamicRules: routed(object('options')),
      getDynamicRules: routed(object('filter', true)),
      updateSessionRules: routed(object('options')),
      getSessionRules: routed(object('filter', true)),
      updateEnabledRulesets: routed(object('options')),
      getEnabledRulesets: routed(),
      updateStaticRules: routed(object('options')),
      getDisabledRuleIds: routed(object('options')),
      getAvailableStaticRuleCount: routed(),
      getMatchedRules: routed(object('filter', true)),
      setExtensionActionOptions: routed(object('options')),
      isRegexSupported: routed(object('regexOptions')),
      testMatchOutcome: routed(object('request'))
    },
    events: { onRuleMatchedDebug: {} },
    constants: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
      GETMATCHEDRULES_QUOTA_INTERVAL: 10,
      DYNAMIC_RULESET_ID: '_dynamic',
      SESSION_RULESET_ID: '_session',
      RuleActionType: {
        BLOCK: 'block',
        REDIRECT: 'redirect',
        ALLOW: 'allow',
        UPGRADE_SCHEME: 'upgradeScheme',
        MODIFY_HEADERS: 'modifyHeaders',
        ALLOW_ALL_REQUESTS: 'allowAllRequests'
      },
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
      DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
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
      HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' }
    }
  },
  webRequest: {
    methods: { handlerBehaviorChanged: routed() },
    events: {
      onBeforeRequest: {},
      onBeforeSendHeaders: {},
      onSendHeaders: {},
      onHeadersReceived: {},
      onAuthRequired: {},
      onResponseStarted: {},
      onBeforeRedirect: {},
      onCompleted: {},
      onErrorOccurred: {},
      onActionIgnored: {}
    },
    constants: {
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      OnBeforeRequestOptions: {
        BLOCKING: 'blocking',
        REQUEST_BODY: 'requestBody',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnBeforeSendHeadersOptions: {
        BLOCKING: 'blocking',
        REQUEST_HEADERS: 'requestHeaders',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnHeadersReceivedOptions: {
        BLOCKING: 'blocking',
        RESPONSE_HEADERS: 'responseHeaders',
        EXTRA_HEADERS: 'extraHeaders'
      },
      OnAuthRequiredOptions: {
        BLOCKING: 'blocking',
        ASYNC_BLOCKING: 'asyncBlocking',
        RESPONSE_HEADERS: 'responseHeaders',
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
      OnErrorOccurredOptions: { EXTRA_HEADERS: 'extraHeaders' }
    }
  },
  webNavigation: {
    methods: { getFrame: routed(object('details')), getAllFrames: routed(object('details')) },
    events: {}
  },
  contextMenus: {
    methods: {
      /** Synchronous in Chrome (returns the id at once); the engine answers the id itself. */
      create: engine(object('createProperties')),
      update: routed({ name: 'id', type: ['integer', 'string'] }, object('updateProperties')),
      remove: routed({ name: 'menuItemId', type: ['integer', 'string'] }),
      removeAll: routed()
    },
    events: {}
  },
  commands: { methods: { getAll: routed() }, events: {} },
  notifications: {
    methods: {
      create: routed({ name: 'notificationId', type: 'string', optional: true }, object('options')),
      update: routed(string('notificationId'), object('options')),
      clear: routed(string('notificationId')),
      getAll: routed(),
      getPermissionLevel: routed()
    },
    events: {}
  },
  cookies: {
    methods: {
      get: routed(object('details')),
      getAll: routed(object('details')),
      set: routed(object('details')),
      remove: routed(object('details')),
      getAllCookieStores: routed()
    },
    events: {}
  },
  history: {
    methods: {
      search: routed(object('query')),
      getVisits: routed(object('details')),
      addUrl: routed(object('details')),
      deleteUrl: routed(object('details')),
      deleteRange: routed(object('range')),
      deleteAll: routed()
    },
    events: { onVisited: {}, onVisitRemoved: {} },
    constants: { TransitionType: API_SPEC.webNavigation?.constants?.TransitionType ?? {} }
  },
  bookmarks: {
    methods: {
      get: routed({ name: 'idOrIdList', type: ['string', 'array'] }),
      getChildren: routed(string('id')),
      getRecent: routed(integer('numberOfItems')),
      getTree: routed(),
      getSubTree: routed(string('id')),
      search: routed({ name: 'query', type: ['string', 'object'] }),
      create: routed(object('bookmark')),
      move: routed(string('id'), object('destination')),
      update: routed(string('id'), object('changes')),
      remove: routed(string('id')),
      removeTree: routed(string('id'))
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
      BookmarkTreeNodeType: { BOOKMARK: 'bookmark', FOLDER: 'folder' },
      BookmarkTreeNodeUnmodifiable: { MANAGED: 'managed' }
    }
  },
  permissions: {
    methods: {
      addHostAccessRequest: routed(object('request')),
      removeHostAccessRequest: routed(object('request'))
    },
    events: {}
  },
  management: {
    methods: { installReplacementWebApp: routed() },
    events: {}
  },
  offscreen: {
    methods: {
      createDocument: routed(object('parameters')),
      closeDocument: routed(),
      hasDocument: routed()
    },
    events: {},
    constants: {
      Reason: {
        TESTING: 'TESTING',
        AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
        IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
        DOM_SCRAPING: 'DOM_SCRAPING',
        BLOBS: 'BLOBS',
        DOM_PARSER: 'DOM_PARSER',
        USER_MEDIA: 'USER_MEDIA',
        DISPLAY_MEDIA: 'DISPLAY_MEDIA',
        WEB_RTC: 'WEB_RTC',
        CLIPBOARD: 'CLIPBOARD',
        LOCAL_STORAGE: 'LOCAL_STORAGE',
        WORKERS: 'WORKERS',
        BATTERY_STATUS: 'BATTERY_STATUS',
        MATCH_MEDIA: 'MATCH_MEDIA',
        GEOLOCATION: 'GEOLOCATION'
      }
    }
  },
  sidePanel: {
    methods: {
      setOptions: stub(object('options')),
      getOptions: stub(object('options')),
      setPanelBehavior: stub(object('behavior')),
      getPanelBehavior: stub(),
      open: stub(object('options'))
    },
    events: {}
  },
  userScripts: {
    methods: {
      register: routed(array('scripts')),
      getScripts: routed(object('filter', true)),
      unregister: routed(object('filter', true)),
      update: routed(array('scripts')),
      configureWorld: routed(object('properties')),
      resetWorldConfiguration: routed(string('worldId', true)),
      getWorldConfigurations: routed(),
      execute: routed(object('injection'))
    },
    events: {},
    constants: { ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' } }
  },
  idle: {
    methods: {
      queryState: routed(integer('detectionIntervalInSeconds')),
      setDetectionInterval: engine(integer('intervalInSeconds')),
      getAutoLockDelay: routed()
    },
    events: { onStateChanged: {} },
    constants: { IdleState: { ACTIVE: 'active', IDLE: 'idle', LOCKED: 'locked' } }
  },
  identity: {
    methods: {
      getAuthToken: stub(object('details', true)),
      getProfileUserInfo: stub(object('details', true)),
      removeCachedAuthToken: stub(object('details')),
      clearAllCachedAuthTokens: stub(),
      launchWebAuthFlow: stub(object('details')),
      getRedirectURL: engine(string('path', true)),
      getAccounts: stub()
    },
    events: { onSignInChanged: {} },
    constants: { AccountStatus: { SYNC: 'SYNC', ANY: 'ANY' } }
  },
  sessions: {
    methods: {
      getRecentlyClosed: stub(object('filter', true)),
      getDevices: stub(object('filter', true)),
      restore: stub(string('sessionId', true))
    },
    events: { onChanged: {} },
    constants: { MAX_SESSION_RESULTS: 25 }
  },
  tabGroups: {
    methods: {
      get: stub(integer('groupId')),
      query: stub(object('queryInfo')),
      update: stub(integer('groupId'), object('updateProperties')),
      move: stub(integer('groupId'), object('moveProperties'))
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
    }
  },
  downloads: {
    methods: {
      download: routed(object('options')),
      search: stub(object('query')),
      pause: stub(integer('downloadId')),
      resume: stub(integer('downloadId')),
      cancel: stub(integer('downloadId')),
      getFileIcon: stub(integer('downloadId'), object('options', true)),
      open: stub(integer('downloadId')),
      show: stub(integer('downloadId')),
      showDefaultFolder: stub(),
      erase: stub(object('query')),
      removeFile: stub(integer('downloadId')),
      acceptDanger: stub(integer('downloadId')),
      setShelfEnabled: stub({ name: 'enabled', type: 'boolean' }),
      setUiOptions: stub(object('options'))
    },
    events: { onCreated: {}, onErased: {}, onChanged: {}, onDeterminingFilename: {} },
    constants: {
      State: { IN_PROGRESS: 'in_progress', INTERRUPTED: 'interrupted', COMPLETE: 'complete' },
      DangerType: {
        FILE: 'file',
        URL: 'url',
        CONTENT: 'content',
        SAFE: 'safe',
        ACCEPTED: 'accepted'
      }
    }
  },
  fontSettings: {
    methods: {
      getFontList: routed(),
      getFont: routed(object('details')),
      setFont: routed(object('details')),
      clearFont: routed(object('details')),
      getDefaultFontSize: routed(object('details', true)),
      setDefaultFontSize: routed(object('details'))
    },
    events: {},
    constants: {
      ScriptCode: {},
      GenericFamily: {
        STANDARD: 'standard',
        SANSSERIF: 'sansserif',
        SERIF: 'serif',
        FIXED: 'fixed',
        CURSIVE: 'cursive',
        FANTASY: 'fantasy',
        MATH: 'math'
      },
      LevelOfControl: {
        NOT_CONTROLLABLE: 'not_controllable',
        CONTROLLED_BY_OTHER_EXTENSIONS: 'controlled_by_other_extensions',
        CONTROLLABLE_BY_THIS_EXTENSION: 'controllable_by_this_extension',
        CONTROLLED_BY_THIS_EXTENSION: 'controlled_by_this_extension'
      }
    }
  },
  search: {
    methods: { query: routed(object('queryInfo')) },
    events: {},
    constants: {
      Disposition: { CURRENT_TAB: 'CURRENT_TAB', NEW_TAB: 'NEW_TAB', NEW_WINDOW: 'NEW_WINDOW' }
    }
  },
  browsingData: {
    methods: {
      remove: stub(object('options'), object('dataToRemove')),
      removeCache: stub(object('options')),
      removeCookies: stub(object('options')),
      removeHistory: stub(object('options')),
      removeLocalStorage: stub(object('options')),
      settings: stub()
    },
    events: {}
  },
  privacy: { methods: {}, events: {} },
  omnibox: {
    methods: { setDefaultSuggestion: stub(object('suggestion')) },
    events: {
      onInputStarted: {},
      onInputChanged: {},
      onInputEntered: {},
      onInputCancelled: {},
      onDeleteSuggestion: {}
    },
    constants: {
      OnInputEnteredDisposition: {
        CURRENT_TAB: 'currentTab',
        NEW_FOREGROUND_TAB: 'newForegroundTab',
        NEW_BACKGROUND_TAB: 'newBackgroundTab'
      }
    }
  },
  tabCapture: {
    methods: {
      capture: stub(object('options')),
      getCapturedTabs: stub(),
      getMediaStreamId: stub(object('options', true))
    },
    events: { onStatusChanged: {} }
  },
  desktopCapture: {
    methods: {
      chooseDesktopMedia: stub(array('sources'), any('targetTab')),
      cancelChooseDesktopMedia: stub(integer('desktopMediaRequestId'))
    },
    events: {}
  },
  system: { methods: {}, events: {} },
  devtools: { methods: {}, events: {} },
  readingList: {
    methods: {
      addEntry: stub(object('entry')),
      removeEntry: stub(object('info')),
      updateEntry: stub(object('info')),
      query: stub(object('info'))
    },
    events: { onEntryAdded: {}, onEntryRemoved: {}, onEntryUpdated: {} }
  },
  webRequestAuthProvider: { methods: {}, events: {} },
  dom: {
    methods: { openOrClosedShadowRoot: engine(any('element', false)) },
    events: {}
  }
}

/**
 * The permission a namespace needs to exist on `chrome` (`null`: always there). Chrome exposes
 * `tabs` and `windows` without their permissions (they only widen what the objects carry),
 * `action` / `browserAction` / `pageAction` by manifest version, and these by permission.
 */
export const NAMESPACE_PERMISSIONS: Record<string, string | null> = {
  runtime: null,
  storage: 'storage',
  i18n: null,
  extension: null,
  tabs: null,
  windows: null,
  action: null,
  browserAction: null,
  pageAction: null,
  scripting: 'scripting',
  alarms: 'alarms',
  notifications: 'notifications',
  contextMenus: 'contextMenus',
  webNavigation: 'webNavigation',
  declarativeNetRequest: 'declarativeNetRequest',
  webRequest: 'webRequest',
  commands: null,
  cookies: 'cookies',
  history: 'history',
  bookmarks: 'bookmarks',
  permissions: null,
  management: null,
  offscreen: 'offscreen',
  sidePanel: 'sidePanel',
  userScripts: 'userScripts',
  idle: 'idle',
  identity: 'identity',
  sessions: 'sessions',
  tabGroups: 'tabGroups',
  downloads: 'downloads',
  fontSettings: 'fontSettings',
  search: 'search',
  browsingData: 'browsingData',
  privacy: 'privacy',
  omnibox: null,
  tabCapture: 'tabCapture',
  desktopCapture: 'desktopCapture',
  system: null,
  devtools: null,
  readingList: 'readingList',
  webRequestAuthProvider: 'webRequestAuthProvider',
  dom: null
}

/** Permissions that grant a namespace registered under another name. */
const PERMISSION_ALIASES: Record<string, string> = {
  declarativeNetRequestWithHostAccess: 'declarativeNetRequest',
  declarativeNetRequestFeedback: 'declarativeNetRequest',
  webRequestBlocking: 'webRequest'
}

/** What content scripts see of `chrome` (everything else exists in extension pages only). */
export const CONTENT_SCRIPT_NAMESPACES: ReadonlySet<string> = new Set([
  'runtime',
  'storage',
  'i18n',
  'extension',
  'dom'
])

/**
 * Members the host answers with nothing after one console warning: setters and fire-and-forget
 * calls extensions make while starting (`setUninstallURL`, `userScripts.configureWorld`) must
 * not end their initialisation with a rejection. Keys are `namespace.method`.
 */
export const ENGINE_NOOPS: ReadonlySet<string> = new Set([
  'runtime.setUninstallURL',
  'tabs.highlight',
  'tabs.setZoomSettings',
  'declarativeNetRequest.setExtensionActionOptions',
  'declarativeNetRequest.updateStaticRules',
  'userScripts.configureWorld',
  'userScripts.resetWorldConfiguration',
  'fontSettings.setFont',
  'fontSettings.clearFont',
  'fontSettings.setDefaultFontSize',
  'extension.setUpdateUrlData',
  'webRequest.handlerBehaviorChanged'
])

/**
 * What unimplemented getters resolve with instead of rejecting, for callers that cannot cope
 * with an error (an empty font list keeps Dark Reader's settings page rendering). JSON values.
 */
export const ENGINE_STUB_RESULTS: Readonly<Record<string, unknown>> = {
  'fontSettings.getFontList': [],
  'fontSettings.getFont': { fontId: '', levelOfControl: 'not_controllable' },
  'fontSettings.getDefaultFontSize': { pixelSize: 16, levelOfControl: 'not_controllable' },
  'declarativeNetRequest.getMatchedRules': { rulesMatchedInfo: [] },
  'declarativeNetRequest.getDisabledRuleIds': [],
  'downloads.search': [],
  'sessions.getRecentlyClosed': [],
  'sessions.getDevices': [],
  'tabGroups.query': [],
  'readingList.query': [],
  'identity.getProfileUserInfo': { email: '', id: '' },
  'cookies.getPartitionKey': { partitionKey: {} },
  'notifications.getAll': {}
}

/** Whether a manifest with these permissions gets the namespace at all. */
export function namespaceGranted(
  namespace: string,
  permissions: readonly string[],
  manifestVersion: 2 | 3
): boolean {
  if (namespace === 'action') return manifestVersion === 3
  if (namespace === 'browserAction' || namespace === 'pageAction') return manifestVersion === 2
  const needed = NAMESPACE_PERMISSIONS[namespace]
  if (needed === undefined) return false
  if (needed === null) return true
  return permissions.some((p) => p === needed || PERMISSION_ALIASES[p] === needed)
}

export interface EngineSpecOptions {
  permissions: readonly string[]
  manifestVersion: 2 | 3
  /** Content scripts see `CONTENT_SCRIPT_NAMESPACES` only. */
  context: 'content' | 'page'
}

function mergeNamespace(
  base: NamespaceSpec | undefined,
  over: NamespaceSpec | undefined
): NamespaceSpec {
  return {
    methods: { ...base?.methods, ...over?.methods },
    events: { ...base?.events, ...over?.events },
    ...(base?.constants || over?.constants
      ? { constants: { ...base?.constants, ...over?.constants } }
      : {}),
    ...((base?.manifestVersion ?? over?.manifestVersion)
      ? { manifestVersion: base?.manifestVersion ?? over?.manifestVersion }
      : {}),
    // A namespace the engine's host implements is no longer a shape.
    ...(base?.shape && !over ? { shape: base.shape } : {})
  }
}

/**
 * The full table an emulated engine installs for one extension context: the browser layer's
 * `API_SPEC` plus the engine's members, with the engine's version of a member winning (a
 * member the layer still ships as a shape but the engine's host implements routes to the
 * host), filtered to the namespaces this manifest and context get.
 */
export function engineApiSpec(options: EngineSpecOptions): ApiSpec {
  const out: ApiSpec = {}
  const names = new Set([...Object.keys(API_SPEC), ...Object.keys(ENGINE_SPEC)])
  for (const name of names) {
    if (options.context === 'content' && !CONTENT_SCRIPT_NAMESPACES.has(name)) continue
    if (!namespaceGranted(name, options.permissions, options.manifestVersion)) continue
    const merged = mergeNamespace(API_SPEC[name], ENGINE_SPEC[name])
    if (merged.manifestVersion && merged.manifestVersion !== options.manifestVersion) continue
    out[name] = merged
  }
  return out
}
