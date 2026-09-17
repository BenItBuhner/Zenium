/**
 * The chrome.* surface the emulation layer knows about. The shim builds every namespace from this
 * table (methods become host calls, events become listener registries), so the same list also
 * documents what is implemented. A member that is absent here does not exist on `chrome`, exactly
 * as in a Chrome build that lacks the permission.
 *
 * Status per member:
 *  - `ok`      implemented by the host (Kotlin) or the browser core;
 *  - `partial` implemented with a documented caveat;
 *  - `stub`    present, rejects with a "not implemented on Zenium for Android" error (or resolves
 *              with the namespace's `stubResults` entry when one exists, for getters whose callers
 *              cannot cope with an error);
 *  - `noop`    present, resolves with nothing after one console warning: setters and
 *              fire-and-forget calls extensions make during startup (`setUninstallURL`,
 *              `userScripts.configureWorld`) must not abort their initialisation chains;
 *  - `local`   answered inside the shim without a host round-trip.
 */
export type MemberStatus = 'ok' | 'partial' | 'stub' | 'noop' | 'local'

export interface NamespaceSchema {
  /** Available in content scripts too (everything is available in extension pages). */
  contentScript: boolean
  /** Permission gating the namespace; null when always present. */
  permission: string | null
  methods: Record<string, MemberStatus>
  events: string[]
  /** Plain constants copied onto the namespace object. */
  constants?: Record<string, unknown>
  /** What `stub` methods resolve with instead of rejecting (JSON values only). */
  stubResults?: Record<string, unknown>
}

export const API_SCHEMA: Record<string, NamespaceSchema> = {
  runtime: {
    contentScript: true,
    permission: null,
    methods: {
      getURL: 'local',
      getManifest: 'local',
      sendMessage: 'ok',
      connect: 'ok',
      getPlatformInfo: 'local',
      openOptionsPage: 'ok',
      reload: 'ok',
      setUninstallURL: 'noop',
      requestUpdateCheck: 'stub',
      getBackgroundPage: 'stub',
      getContexts: 'partial',
      sendNativeMessage: 'stub',
      connectNative: 'stub',
      restart: 'stub',
      restartAfterDelay: 'stub',
      getPackageDirectoryEntry: 'stub'
    },
    events: [
      'onMessage',
      'onMessageExternal',
      'onConnect',
      'onConnectExternal',
      'onInstalled',
      'onStartup',
      'onSuspend',
      'onSuspendCanceled',
      'onUpdateAvailable',
      'onRestartRequired',
      'onUserScriptMessage',
      'onUserScriptConnect'
    ],
    constants: {
      OnInstalledReason: {
        INSTALL: 'install',
        UPDATE: 'update',
        CHROME_UPDATE: 'chrome_update',
        SHARED_MODULE_UPDATE: 'shared_module_update'
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
  storage: {
    contentScript: true,
    permission: 'storage',
    methods: {},
    events: ['onChanged']
  },
  i18n: {
    contentScript: true,
    permission: null,
    methods: {
      getMessage: 'local',
      getUILanguage: 'local',
      getAcceptLanguages: 'local',
      detectLanguage: 'stub'
    },
    events: []
  },
  extension: {
    contentScript: true,
    permission: null,
    methods: {
      getURL: 'local',
      getBackgroundPage: 'stub',
      getViews: 'stub',
      isAllowedIncognitoAccess: 'local',
      isAllowedFileSchemeAccess: 'local',
      setUpdateUrlData: 'stub'
    },
    events: ['onRequest', 'onRequestExternal']
  },
  tabs: {
    contentScript: false,
    permission: null,
    methods: {
      query: 'ok',
      get: 'ok',
      getCurrent: 'ok',
      create: 'ok',
      update: 'ok',
      remove: 'ok',
      reload: 'ok',
      sendMessage: 'ok',
      connect: 'ok',
      executeScript: 'partial',
      insertCSS: 'partial',
      removeCSS: 'stub',
      duplicate: 'ok',
      highlight: 'noop',
      move: 'stub',
      captureVisibleTab: 'partial',
      detectLanguage: 'stub',
      getZoom: 'ok',
      setZoom: 'ok',
      getZoomSettings: 'stub',
      setZoomSettings: 'noop',
      discard: 'ok',
      goBack: 'ok',
      goForward: 'ok',
      group: 'stub',
      ungroup: 'stub'
    },
    events: [
      'onCreated',
      'onUpdated',
      'onActivated',
      'onRemoved',
      'onMoved',
      'onAttached',
      'onDetached',
      'onHighlighted',
      'onReplaced',
      'onZoomChange'
    ],
    constants: {
      TAB_ID_NONE: -1,
      TabStatus: { UNLOADED: 'unloaded', LOADING: 'loading', COMPLETE: 'complete' },
      WindowType: {
        NORMAL: 'normal',
        POPUP: 'popup',
        PANEL: 'panel',
        APP: 'app',
        DEVTOOLS: 'devtools'
      },
      MutedInfoReason: { USER: 'user', CAPTURE: 'capture', EXTENSION: 'extension' }
    }
  },
  windows: {
    contentScript: false,
    permission: null,
    methods: {
      get: 'ok',
      getCurrent: 'ok',
      getLastFocused: 'ok',
      getAll: 'ok',
      create: 'partial',
      update: 'partial',
      remove: 'stub'
    },
    events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
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
  action: {
    contentScript: false,
    permission: null,
    methods: {
      setTitle: 'ok',
      getTitle: 'ok',
      setIcon: 'partial',
      setPopup: 'ok',
      getPopup: 'ok',
      setBadgeText: 'ok',
      getBadgeText: 'ok',
      setBadgeBackgroundColor: 'ok',
      getBadgeBackgroundColor: 'ok',
      setBadgeTextColor: 'ok',
      getBadgeTextColor: 'ok',
      enable: 'ok',
      disable: 'ok',
      isEnabled: 'ok',
      getUserSettings: 'local',
      openPopup: 'ok'
    },
    events: ['onClicked', 'onUserSettingsChanged']
  },
  browserAction: {
    contentScript: false,
    permission: null,
    methods: {
      setTitle: 'ok',
      getTitle: 'ok',
      setIcon: 'partial',
      setPopup: 'ok',
      getPopup: 'ok',
      setBadgeText: 'ok',
      getBadgeText: 'ok',
      setBadgeBackgroundColor: 'ok',
      getBadgeBackgroundColor: 'ok',
      enable: 'ok',
      disable: 'ok',
      openPopup: 'ok'
    },
    events: ['onClicked']
  },
  pageAction: {
    contentScript: false,
    permission: null,
    methods: {
      show: 'ok',
      hide: 'ok',
      setTitle: 'ok',
      getTitle: 'ok',
      setIcon: 'partial',
      setPopup: 'ok',
      getPopup: 'ok'
    },
    events: ['onClicked']
  },
  scripting: {
    contentScript: false,
    permission: 'scripting',
    methods: {
      executeScript: 'partial',
      insertCSS: 'ok',
      removeCSS: 'partial',
      registerContentScripts: 'ok',
      getRegisteredContentScripts: 'ok',
      unregisterContentScripts: 'ok',
      updateContentScripts: 'ok'
    },
    events: [],
    constants: { ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' }, globalParams: {} }
  },
  alarms: {
    contentScript: false,
    permission: 'alarms',
    methods: { create: 'ok', get: 'ok', getAll: 'ok', clear: 'ok', clearAll: 'ok' },
    events: ['onAlarm']
  },
  notifications: {
    contentScript: false,
    permission: 'notifications',
    methods: {
      create: 'partial',
      update: 'partial',
      clear: 'ok',
      getAll: 'ok',
      getPermissionLevel: 'local'
    },
    events: [
      'onClosed',
      'onClicked',
      'onButtonClicked',
      'onPermissionLevelChanged',
      'onShowSettings'
    ],
    constants: {
      TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' },
      PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' }
    }
  },
  contextMenus: {
    contentScript: false,
    permission: 'contextMenus',
    methods: { create: 'partial', update: 'partial', remove: 'ok', removeAll: 'ok' },
    events: ['onClicked'],
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
  webNavigation: {
    contentScript: false,
    permission: 'webNavigation',
    methods: { getFrame: 'partial', getAllFrames: 'partial' },
    events: [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
      'onErrorOccurred',
      'onCreatedNavigationTarget',
      'onReferenceFragmentUpdated',
      'onTabReplaced',
      'onHistoryStateUpdated'
    ],
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
  declarativeNetRequest: {
    contentScript: false,
    permission: 'declarativeNetRequest',
    methods: {
      updateDynamicRules: 'ok',
      getDynamicRules: 'ok',
      updateSessionRules: 'ok',
      getSessionRules: 'ok',
      updateEnabledRulesets: 'ok',
      getEnabledRulesets: 'ok',
      updateStaticRules: 'partial',
      getDisabledRuleIds: 'partial',
      getAvailableStaticRuleCount: 'local',
      getMatchedRules: 'stub',
      setExtensionActionOptions: 'noop',
      isRegexSupported: 'local',
      testMatchOutcome: 'stub'
    },
    events: ['onRuleMatchedDebug'],
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
    contentScript: false,
    permission: 'webRequest',
    methods: { handlerBehaviorChanged: 'local' },
    events: [
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onSendHeaders',
      'onHeadersReceived',
      'onAuthRequired',
      'onResponseStarted',
      'onBeforeRedirect',
      'onCompleted',
      'onErrorOccurred',
      'onActionIgnored'
    ],
    constants: {
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      OnBeforeRequestOptions: { BLOCKING: 'blocking', REQUEST_BODY: 'requestBody', EXTRA_HEADERS: 'extraHeaders' },
      OnBeforeSendHeadersOptions: { BLOCKING: 'blocking', REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnHeadersReceivedOptions: { BLOCKING: 'blocking', RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnAuthRequiredOptions: { BLOCKING: 'blocking', ASYNC_BLOCKING: 'asyncBlocking', RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnResponseStartedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnBeforeRedirectOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnCompletedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnErrorOccurredOptions: { EXTRA_HEADERS: 'extraHeaders' }
    }
  },
  commands: {
    contentScript: false,
    permission: null,
    methods: { getAll: 'ok' },
    events: ['onCommand']
  },
  cookies: {
    contentScript: false,
    permission: 'cookies',
    methods: {
      get: 'partial',
      getAll: 'partial',
      set: 'partial',
      remove: 'partial',
      getAllCookieStores: 'local',
      getPartitionKey: 'stub'
    },
    events: ['onChanged']
  },
  history: {
    contentScript: false,
    permission: 'history',
    methods: {
      search: 'partial',
      getVisits: 'stub',
      addUrl: 'partial',
      deleteUrl: 'partial',
      deleteRange: 'stub',
      deleteAll: 'partial'
    },
    events: ['onVisited', 'onVisitRemoved']
  },
  bookmarks: {
    contentScript: false,
    permission: 'bookmarks',
    methods: {
      get: 'partial',
      getChildren: 'partial',
      getRecent: 'partial',
      getTree: 'partial',
      getSubTree: 'partial',
      search: 'partial',
      create: 'partial',
      move: 'stub',
      update: 'partial',
      remove: 'partial',
      removeTree: 'stub'
    },
    events: [
      'onCreated',
      'onRemoved',
      'onChanged',
      'onMoved',
      'onChildrenReordered',
      'onImportBegan',
      'onImportEnded'
    ]
  },
  permissions: {
    contentScript: false,
    permission: null,
    methods: {
      contains: 'ok',
      getAll: 'ok',
      request: 'partial',
      remove: 'ok',
      addHostAccessRequest: 'stub',
      removeHostAccessRequest: 'stub'
    },
    events: ['onAdded', 'onRemoved']
  },
  management: {
    contentScript: false,
    permission: null,
    methods: {
      getSelf: 'ok',
      getAll: 'partial',
      get: 'partial',
      uninstallSelf: 'ok',
      setEnabled: 'stub',
      getPermissionWarningsById: 'stub',
      getPermissionWarningsByManifest: 'stub',
      launchApp: 'stub',
      createAppShortcut: 'stub',
      setLaunchType: 'stub',
      generateAppForLink: 'stub',
      installReplacementWebApp: 'stub'
    },
    events: ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']
  },
  offscreen: {
    contentScript: false,
    permission: 'offscreen',
    methods: { createDocument: 'partial', closeDocument: 'ok', hasDocument: 'ok' },
    events: [],
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
    contentScript: false,
    permission: 'sidePanel',
    methods: {
      setOptions: 'stub',
      getOptions: 'stub',
      setPanelBehavior: 'stub',
      getPanelBehavior: 'stub',
      open: 'stub'
    },
    events: []
  },
  userScripts: {
    contentScript: false,
    permission: 'userScripts',
    methods: {
      register: 'partial',
      getScripts: 'ok',
      unregister: 'ok',
      update: 'partial',
      configureWorld: 'noop',
      resetWorldConfiguration: 'noop',
      getWorldConfigurations: 'stub',
      execute: 'stub'
    },
    events: [],
    constants: { ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' } }
  },
  idle: {
    contentScript: false,
    permission: 'idle',
    methods: { queryState: 'partial', setDetectionInterval: 'local', getAutoLockDelay: 'stub' },
    events: ['onStateChanged']
  },
  identity: {
    contentScript: false,
    permission: 'identity',
    methods: {
      getAuthToken: 'stub',
      getProfileUserInfo: 'stub',
      removeCachedAuthToken: 'stub',
      clearAllCachedAuthTokens: 'stub',
      launchWebAuthFlow: 'stub',
      getRedirectURL: 'local',
      getAccounts: 'stub'
    },
    events: ['onSignInChanged']
  },
  sessions: {
    contentScript: false,
    permission: 'sessions',
    methods: { getRecentlyClosed: 'stub', getDevices: 'stub', restore: 'stub' },
    events: ['onChanged'],
    constants: { MAX_SESSION_RESULTS: 25 }
  },
  tabGroups: {
    contentScript: false,
    permission: 'tabGroups',
    methods: { get: 'stub', query: 'stub', update: 'stub', move: 'stub' },
    events: ['onCreated', 'onUpdated', 'onMoved', 'onRemoved'],
    constants: { TAB_GROUP_ID_NONE: -1 }
  },
  downloads: {
    contentScript: false,
    permission: 'downloads',
    methods: {
      download: 'partial',
      search: 'stub',
      pause: 'stub',
      resume: 'stub',
      cancel: 'stub',
      getFileIcon: 'stub',
      open: 'stub',
      show: 'stub',
      showDefaultFolder: 'stub',
      erase: 'stub',
      removeFile: 'stub',
      acceptDanger: 'stub',
      setShelfEnabled: 'stub',
      setUiOptions: 'stub'
    },
    events: ['onCreated', 'onErased', 'onChanged', 'onDeterminingFilename']
  },
  fontSettings: {
    contentScript: false,
    permission: 'fontSettings',
    methods: {
      getFontList: 'stub',
      getFont: 'stub',
      setFont: 'noop',
      clearFont: 'noop',
      getDefaultFontSize: 'stub',
      setDefaultFontSize: 'noop'
    },
    events: [],
    // No font list on Android; an empty list keeps settings pages (Dark Reader) rendering.
    stubResults: { getFontList: [], getFont: { fontId: '', levelOfControl: 'not_controllable' } }
  },
  search: {
    contentScript: false,
    permission: 'search',
    methods: { query: 'ok' },
    events: [],
    constants: {
      Disposition: { CURRENT_TAB: 'CURRENT_TAB', NEW_TAB: 'NEW_TAB', NEW_WINDOW: 'NEW_WINDOW' }
    }
  },
  browsingData: {
    contentScript: false,
    permission: 'browsingData',
    methods: {
      remove: 'stub',
      removeCache: 'stub',
      removeCookies: 'stub',
      removeHistory: 'stub',
      removeLocalStorage: 'stub',
      settings: 'stub'
    },
    events: []
  },
  privacy: {
    contentScript: false,
    permission: 'privacy',
    methods: {},
    events: []
  },
  omnibox: {
    contentScript: false,
    permission: null,
    methods: { setDefaultSuggestion: 'stub' },
    events: [
      'onInputStarted',
      'onInputChanged',
      'onInputEntered',
      'onInputCancelled',
      'onDeleteSuggestion'
    ]
  },
  tabCapture: {
    contentScript: false,
    permission: 'tabCapture',
    methods: { capture: 'stub', getCapturedTabs: 'stub', getMediaStreamId: 'stub' },
    events: ['onStatusChanged']
  },
  desktopCapture: {
    contentScript: false,
    permission: 'desktopCapture',
    methods: { chooseDesktopMedia: 'stub', cancelChooseDesktopMedia: 'stub' },
    events: []
  },
  system: {
    contentScript: false,
    permission: null,
    methods: {},
    events: []
  },
  devtools: {
    contentScript: false,
    permission: null,
    methods: {},
    events: []
  },
  readingList: {
    contentScript: false,
    permission: 'readingList',
    methods: { addEntry: 'stub', removeEntry: 'stub', updateEntry: 'stub', query: 'stub' },
    events: ['onEntryAdded', 'onEntryRemoved', 'onEntryUpdated']
  },
  webRequestAuthProvider: {
    contentScript: false,
    permission: 'webRequestAuthProvider',
    methods: {},
    events: []
  },
  dom: {
    contentScript: true,
    permission: null,
    methods: { openOrClosedShadowRoot: 'local' },
    events: []
  }
}

/** Permissions that expose a namespace under a different name. */
const PERMISSION_ALIASES: Record<string, string> = {
  declarativeNetRequestWithHostAccess: 'declarativeNetRequest',
  declarativeNetRequestFeedback: 'declarativeNetRequest',
  webRequestBlocking: 'webRequest'
}

/** Whether a manifest with `permissions` (and `manifestVersion`) gets the namespace at all. */
export function namespaceGranted(
  name: string,
  permissions: string[],
  manifestVersion: 2 | 3
): boolean {
  const schema = API_SCHEMA[name]
  if (!schema) return false
  if (name === 'action') return manifestVersion === 3
  if (name === 'browserAction' || name === 'pageAction') return manifestVersion === 2
  if (!schema.permission) return true
  return permissions.some(
    (p) => p === schema.permission || PERMISSION_ALIASES[p] === schema.permission
  )
}

export interface ApiMember {
  namespace: string
  member: string
  kind: 'method' | 'event'
  status: MemberStatus | 'absent'
}

/** Look up how the layer treats `chrome.<namespace>.<member>` (for compatibility audits). */
export function apiMember(namespace: string, member: string): ApiMember {
  const schema = API_SCHEMA[namespace]
  if (!schema) return { namespace, member, kind: 'method', status: 'absent' }
  if (member in schema.methods)
    return { namespace, member, kind: 'method', status: schema.methods[member] }
  if (schema.events.includes(member))
    return { namespace, member, kind: 'event', status: eventStatus(namespace, member) }
  if (namespace === 'storage' && ['local', 'sync', 'session', 'managed'].includes(member))
    return { namespace, member, kind: 'method', status: member === 'managed' ? 'partial' : 'ok' }
  return { namespace, member, kind: 'method', status: 'absent' }
}

/** Events the hosts actually raise; the rest exist but never fire. */
const RAISED_EVENTS = new Set([
  'runtime.onMessage',
  'runtime.onConnect',
  'runtime.onInstalled',
  'runtime.onStartup',
  'storage.onChanged',
  'tabs.onCreated',
  'tabs.onUpdated',
  'tabs.onActivated',
  'tabs.onRemoved',
  'windows.onFocusChanged',
  'action.onClicked',
  'browserAction.onClicked',
  'alarms.onAlarm',
  'webNavigation.onBeforeNavigate',
  'webNavigation.onCommitted',
  'webNavigation.onDOMContentLoaded',
  'webNavigation.onCompleted',
  'webNavigation.onErrorOccurred',
  'webNavigation.onHistoryStateUpdated',
  'webNavigation.onReferenceFragmentUpdated',
  'webRequest.onBeforeRequest',
  'webRequest.onCompleted',
  'webRequest.onErrorOccurred',
  'notifications.onClicked',
  'notifications.onClosed',
  'permissions.onAdded',
  'permissions.onRemoved',
  'cookies.onChanged'
])

const PARTIAL_EVENTS = new Set([
  'webRequest.onBeforeRequest',
  'webRequest.onCompleted',
  'webRequest.onErrorOccurred',
  'cookies.onChanged',
  'webNavigation.onBeforeNavigate'
])

export function eventStatus(namespace: string, event: string): MemberStatus {
  const key = `${namespace}.${event}`
  if (PARTIAL_EVENTS.has(key)) return 'partial'
  return RAISED_EVENTS.has(key) ? 'ok' : 'stub'
}
