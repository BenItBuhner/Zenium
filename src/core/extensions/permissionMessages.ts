/**
 * Chrome's install-time permission warnings ("Read and change all your data on all websites",
 * "Read your browsing history", ...) for a manifest, so the install prompt can show exactly what
 * Chrome would show for the same extension.
 *
 * A port of Chromium's rule engine (English strings only):
 *   chrome/common/extensions/permissions/chrome_permission_message_rules.cc
 *     (revision ceb8c209706d5031ea01491832e653c831804aeb, 2026-09-03)
 *   chrome/common/extensions/permissions/chrome_permission_message_provider.cc
 *   extensions/common/permissions/permission_message_util.cc (GetDistinctHosts)
 *   extensions/common/permissions/permission_set.cc (ShouldWarnAllHosts)
 *   chrome/common/extensions/permissions/chrome_api_permissions.cc and
 *   extensions/common/permissions/extensions_api_permissions.cc (name -> id, flags)
 *   chrome/app/generated_resources.grd IDS_EXTENSION_PROMPT_WARNING_* strings
 *     (revision 56015be7f80f60db1032c35e8c0e494263b4d1a7, 2026-09-17)
 *
 * How Chrome does it: every manifest permission becomes one or more permission ids (host
 * patterns become `kHostsAll` or one `kHostReadWrite` per distinct host), then the rule table is
 * applied top to bottom. A rule fires when all its required ids are still available; it then
 * consumes its required and optional ids so later rules cannot repeat them (`<all_urls>` absorbs
 * `tabs`, `history` absorbs `tabs` and `favicon`, ...). Only required permissions count: optional
 * permissions are approved when requested at runtime, not at install time.
 *
 * Deliberate approximations, all documented inline: the registry ("public suffix") lookups use a
 * compact built-in table instead of Chromium's full list, USB device names are not resolved, and
 * feature availability (permissions Chrome silently drops on a platform) is not modelled.
 */

export type PermissionId =
  | 'kAccessibilityFeaturesModify'
  | 'kAccessibilityFeaturesRead'
  | 'kActivityLogPrivate'
  | 'kAudioCapture'
  | 'kAutofillPrivate'
  | 'kBluetooth'
  | 'kBluetoothDevices'
  | 'kBluetoothLowEnergy'
  | 'kBluetoothPeripheral'
  | 'kBluetoothPrivate'
  | 'kBluetoothSocket'
  | 'kBookmark'
  | 'kCertificateProvider'
  | 'kChromeOSAttachedDeviceInfo'
  | 'kChromeOSBluetoothPeripheralsInfo'
  | 'kChromeOSDiagnostics'
  | 'kChromeOSDiagnosticsNetworkInfoForMlab'
  | 'kChromeOSEvents'
  | 'kChromeOSManagementAudio'
  | 'kChromeOSTelemetry'
  | 'kChromeOSTelemetryNetworkInformation'
  | 'kChromeOSTelemetrySerialNumber'
  | 'kClipboardRead'
  | 'kClipboardWrite'
  | 'kContentSettings'
  | 'kDebugger'
  | 'kDeclarativeNetRequest'
  | 'kDeclarativeNetRequestFeedback'
  | 'kDeclarativeWebRequest'
  | 'kDesktopCapture'
  | 'kDocumentScan'
  | 'kDownloads'
  | 'kDownloadsOpen'
  | 'kEnterpriseDeviceAttributes'
  | 'kEnterpriseHardwarePlatform'
  | 'kEnterpriseKioskInput'
  | 'kEnterpriseLogin'
  | 'kEnterpriseNetworkingAttributes'
  | 'kEnterprisePlatformKeys'
  | 'kEnterpriseRemoteApps'
  | 'kEnterpriseReportingPrivate'
  | 'kEnterpriseWebrtc'
  | 'kFavicon'
  | 'kFileSystemDirectory'
  | 'kFileSystemWrite'
  | 'kFullAccess'
  | 'kGeolocation'
  | 'kHistory'
  | 'kHomepage'
  | 'kHostReadOnly'
  | 'kHostReadWrite'
  | 'kHostsAll'
  | 'kHostsAllReadOnly'
  | 'kIdentityEmail'
  | 'kInput'
  | 'kLogin'
  | 'kLoginScreenStorage'
  | 'kLoginScreenUi'
  | 'kManagement'
  | 'kMDns'
  | 'kMediaGalleriesAllGalleriesCopyTo'
  | 'kMediaGalleriesAllGalleriesDelete'
  | 'kMediaGalleriesAllGalleriesRead'
  | 'kNativeMessaging'
  | 'kNetworkingOnc'
  | 'kNetworkingPrivate'
  | 'kNetworkState'
  | 'kNewTabPageOverride'
  | 'kNotifications'
  | 'kOmniboxDirectInput'
  | 'kPasswordsPrivate'
  | 'kPlatformKeys'
  | 'kPrinting'
  | 'kPrintingMetrics'
  | 'kPrivacy'
  | 'kProcesses'
  | 'kReadingList'
  | 'kSearchProvider'
  | 'kSerial'
  | 'kSessions'
  | 'kSettingsPrivate'
  | 'kSocketAnyHost'
  | 'kSocketDomainHosts'
  | 'kSocketSpecificHosts'
  | 'kSpeechRecognitionPrivate'
  | 'kStartupPages'
  | 'kSyncFileSystem'
  | 'kSystemStorage'
  | 'kTab'
  | 'kTabGroups'
  | 'kTopSites'
  | 'kTransientBackground'
  | 'kTtsEngine'
  | 'kU2fDevices'
  | 'kUsbDevice'
  | 'kUsbDeviceUnknownProduct'
  | 'kUsbDeviceUnknownVendor'
  | 'kUsersPrivate'
  | 'kVideoCapture'
  | 'kVpnProvider'
  | 'kWallpaper'
  | 'kWebAuthenticationProxy'
  | 'kWebNavigation'

/** One warning line of the install prompt; `details` are the indented sub-items Chrome shows. */
export interface PermissionWarning {
  message: string
  details: string[]
}

/** The manifest keys the warnings depend on (a validated or raw manifest both work). */
export interface PermissionWarningSource {
  manifest_version?: number
  permissions?: unknown[]
  host_permissions?: unknown[]
  /** Accepted for convenience; optional permissions never warn at install time. */
  optional_permissions?: unknown[]
  optional_host_permissions?: unknown[]
  content_scripts?: Array<{ matches?: unknown[] }>
  devtools_page?: string
  chrome_url_overrides?: { newtab?: string }
  chrome_settings_overrides?: {
    homepage?: string
    search_provider?: { search_url?: string }
    startup_pages?: string[]
  }
  bluetooth?: { uuids?: string[]; socket?: boolean; low_energy?: boolean; peripheral?: boolean }
  app?: unknown
}

// ---------------------------------------------------------------------------
// Strings (generated_resources.grd, English)
// ---------------------------------------------------------------------------

const S = {
  FULL_ACCESS: 'Read and change all your data on your computer and all websites',
  ALL_HOSTS: 'Read and change all your data on all websites',
  ALL_HOSTS_READ_ONLY: 'Read all your data on all websites',
  AUDIO_CAPTURE: 'Use your microphone',
  VIDEO_CAPTURE: 'Use your camera',
  AUDIO_AND_VIDEO_CAPTURE: 'Use your microphone and camera',
  BLUETOOTH:
    'Access information about Bluetooth devices paired with your system and discover nearby Bluetooth devices.',
  BLUETOOTH_DEVICES: 'Send messages to and receive messages from Bluetooth devices.',
  BLUETOOTH_DEVICES_SOCKET:
    'Send messages to and receive messages from Bluetooth devices using sockets.',
  BLUETOOTH_DEVICES_LOW_ENERGY:
    'Send messages to and receive messages from Bluetooth devices using Low Energy.',
  BLUETOOTH_DEVICES_PERIPHERAL:
    'Allow nearby Bluetooth devices to discover and connect to this device.',
  BLUETOOTH_PRIVATE: 'Control Bluetooth adapter state and pairing',
  BLUETOOTH_SERIAL: 'Access your Bluetooth and Serial devices',
  BOOKMARKS: 'Read and change your bookmarks',
  READING_LIST: 'Read and change entries in the reading list',
  CLIPBOARD: 'Read data you copy and paste',
  CLIPBOARD_READWRITE: 'Read and modify data you copy and paste',
  CLIPBOARD_WRITE: 'Modify data you copy and paste',
  DEBUGGER: 'Access the page debugger backend',
  DECLARATIVE_WEB_REQUEST: 'Block parts of web pages',
  DECLARATIVE_NET_REQUEST: 'Block content on any page',
  DOCUMENT_SCAN: 'Access document scanners attached via USB or on the local network',
  ENTERPRISE_HARDWARE_PLATFORM: 'Read the manufacturer and model of this computer',
  FAVICON: 'Read the icons of the websites you visit',
  GEOLOCATION: 'Detect your physical location',
  HISTORY_READ: 'Read your browsing history',
  HISTORY_READ_ON_ALL_DEVICES: 'Read your browsing history on all your signed-in devices',
  HISTORY_WRITE_ON_ALL_DEVICES:
    'Read and change your browsing history on all your signed-in devices',
  HOME_PAGE_SETTING_OVERRIDE: 'Change your home page to: $1',
  ONE_HOST: 'Read and change your data on $1',
  ONE_HOST_READ_ONLY: 'Read your data on $1',
  TWO_HOSTS: 'Read and change your data on $1 and $2',
  TWO_HOSTS_READ_ONLY: 'Read your data on $1 and $2',
  THREE_HOSTS: 'Read and change your data on $1, $2, and $3',
  THREE_HOSTS_READ_ONLY: 'Read your data on $1, $2, and $3',
  HOSTS_LIST: 'Read and change your data on a number of websites',
  HOSTS_LIST_READ_ONLY: 'Read your data on a number of websites',
  HOST_AND_SUBDOMAIN: 'all $1 sites',
  HOST_AND_SUBDOMAIN_LIST: 'All $1 sites',
  INPUT: 'Read and change anything you type',
  LOGIN: 'Launch and exit managed guest sessions',
  ENTERPRISE_LOGIN: 'Exit managed guest sessions',
  LOGIN_SCREEN_UI: 'Display UI on the login screen',
  LOGIN_SCREEN_STORAGE:
    'Store persistent data on the login screen and inject credentials into the session.',
  MANAGEMENT: 'Manage your apps, extensions, and themes',
  MDNS: 'Discover devices on your local network, like printers',
  NETWORK_STATE: 'Access list of network connections',
  NETWORKING_PRIVATE: 'Manage network connections',
  PRINTING: 'Access your printers',
  PRINTING_METRICS: 'See your printing history',
  SEARCH_SETTINGS_OVERRIDE: 'Change your search settings to: $1',
  SERIAL: 'Access your serial devices',
  SOCKET_ANY_HOST: 'Exchange data with any device on the local network or internet',
  SOCKET_HOSTS_IN_DOMAIN: 'Exchange data with any device in the domain $1',
  SOCKET_HOSTS_IN_DOMAINS: 'Exchange data with any device in the domains: $1',
  SOCKET_SPECIFIC_HOST: 'Exchange data with the device named $1',
  SOCKET_SPECIFIC_HOSTS: 'Exchange data with the devices named: $1',
  SPEECH_RECOGNITION: 'Access your microphone and analyze your speech',
  START_PAGE_SETTING_OVERRIDE: 'Change your start page to: $1',
  SYSTEM_STORAGE: 'Identify and eject storage devices',
  TAB_GROUPS: 'View and manage your tab groups',
  TOPSITES: 'Read a list of your most frequently visited websites',
  TTS_ENGINE: 'Read all text spoken using synthesized speech',
  U2F_DEVICES: 'Access your Universal 2nd Factor devices',
  NOTIFICATIONS: 'Display notifications',
  USB_DEVICE: 'Access any $1 via USB',
  USB_DEVICE_LIST: 'Access any of these USB devices',
  USB_DEVICE_LIST_ITEM_UNKNOWN_PRODUCT: 'unknown devices from $1',
  USB_DEVICE_LIST_ITEM_UNKNOWN_VENDOR: 'devices from an unknown vendor',
  USB_DEVICE_UNKNOWN_PRODUCT: 'Access USB devices from $1',
  USB_DEVICE_UNKNOWN_VENDOR: 'Access USB devices from an unknown vendor',
  VPN: 'Access your network traffic',
  CONTENT_SETTINGS:
    'Change and grant access to features such as geolocation, microphone, camera, cookies, etc., for all your websites and extensions, including this extension.',
  PRIVACY: 'Change your privacy-related settings',
  DOWNLOADS: 'Manage your downloads',
  DOWNLOADS_OPEN: 'Open downloaded files',
  IDENTITY_EMAIL: 'Know your email address',
  WALLPAPER: 'Change your wallpaper',
  FILE_SYSTEM_DIRECTORY: 'Read folders that you open in the application',
  FILE_SYSTEM_WRITE_DIRECTORY: 'Write to files and folders that you open in the application',
  MEDIA_GALLERIES_READ: 'Access photos, music, and other media from your computer',
  MEDIA_GALLERIES_READ_WRITE: 'Read and change photos, music, and other media from your computer',
  MEDIA_GALLERIES_READ_DELETE: 'Read and delete photos, music, and other media from your computer',
  MEDIA_GALLERIES_READ_WRITE_DELETE:
    'Read, change and delete photos, music, and other media from your computer',
  SYNCFILESYSTEM: 'Store data in your Google Drive account',
  NATIVE_MESSAGING: 'Communicate with cooperating native applications',
  ACTIVITY_LOG_PRIVATE: 'Monitor the behavior of other extensions, including visited URLs',
  DESKTOP_CAPTURE: 'Capture content of your screen',
  ACCESSIBILITY_FEATURES_MODIFY: 'Change your accessibility settings',
  ACCESSIBILITY_FEATURES_READ: 'Read your accessibility settings',
  ACCESSIBILITY_FEATURES_READ_MODIFY: 'Read and change your accessibility settings',
  PLATFORMKEYS: 'Use your client certificates',
  CERTIFICATEPROVIDER: 'Provide certificates for authentication',
  SETTINGS_PRIVATE: 'Read and change user and device settings',
  AUTOFILL_PRIVATE: 'Read and change autofill settings',
  PASSWORDS_PRIVATE: 'Read and change saved password settings',
  USERS_PRIVATE: 'Read and change allowlisted users',
  NEW_TAB_PAGE_OVERRIDE: 'Replace the page you see when opening a new tab',
  TRANSIENT_BACKGROUND: 'Run in the background when requested by a cooperating native application',
  ENTERPRISE_DEVICE_ATTRIBUTES: 'See device information, such as its serial number or asset ID',
  ENTERPRISE_WEBRTC: 'See which sites you call from and when your camera or microphone is used',
  ENTERPRISE_KIOSK_INPUT: 'Change the system keyboard layout',
  ENTERPRISE_NETWORKING_ATTRIBUTES: 'See network information, such as your IP or MAC address',
  ENTERPRISE_PLATFORMKEYS:
    'Perform security-related tasks for your organization, such as managing certificates and keys stored on the device',
  ENTERPRISE_REPORTING_PRIVATE_WIN:
    'Read information about your browser, OS, device, installed software, registry values and files',
  ENTERPRISE_REPORTING_PRIVATE_LINUX_AND_MACOS:
    'Read information about your browser, OS, device, installed software and files',
  ENTERPRISE_REPORTING_PRIVATE: 'Read information about your browser, OS, and device',
  ENTERPRISE_REMOTE_APPS: 'Add remote apps to the ChromeOS launcher',
  CHROMEOS_ATTACHED_DEVICE_INFO: 'Read attached devices information and data',
  CHROMEOS_BLUETOOTH_PERIPHERALS_INFO: 'Read Bluetooth peripherals information and data',
  CHROMEOS_DIAGNOSTICS: 'Run ChromeOS diagnostic tests',
  CHROMEOS_DIAGNOSTICS_NETWORK_INFO_FOR_MLAB:
    'Collect IP address and network measurement results for Measurement Lab, according to their privacy policy (measurementlab.net/privacy)',
  CHROMEOS_EVENTS: 'Subscribe to ChromeOS system events',
  CHROMEOS_MANAGEMENT_AUDIO: 'Manage ChromeOS audio settings',
  CHROMEOS_TELEMETRY: 'Read ChromeOS device information and data',
  CHROMEOS_TELEMETRY_SERIAL_NUMBER: 'Read ChromeOS device and component serial numbers',
  CHROMEOS_TELEMETRY_NETWORK_INFORMATION: 'Read ChromeOS network information',
  OMNIBOX_DIRECT_INPUT: 'Read and save keyboard input from the address bar'
} as const

function format(template: string, ...args: string[]): string {
  return template.replace(/\$(\d)/g, (_, n: string) => args[Number(n) - 1] ?? '')
}

// ---------------------------------------------------------------------------
// Manifest permission names -> ids (chrome_api_permissions.cc, extensions_api_permissions.cc)
// ---------------------------------------------------------------------------

/**
 * Permissions with a message of their own, or that take part in an absorption rule. Every other
 * known permission (storage, alarms, activeTab, scripting, contextMenus, cookies, webRequest,
 * unlimitedStorage, sidePanel, offscreen, ...) is valid but Chrome shows nothing for it, so it
 * is simply absent here. Structured ids (kUsbDevice*, kSocket*, kMediaGalleries*, kHomepage,
 * kSearchProvider, kStartupPages, kBluetooth*, kNewTabPageOverride) come from other manifest
 * entries, see `permissionIdsForManifest`.
 */
const API_PERMISSION_IDS: Readonly<Record<string, PermissionId>> = {
  'accessibilityFeatures.modify': 'kAccessibilityFeaturesModify',
  'accessibilityFeatures.read': 'kAccessibilityFeaturesRead',
  activityLogPrivate: 'kActivityLogPrivate',
  audioCapture: 'kAudioCapture',
  autofillPrivate: 'kAutofillPrivate',
  bluetoothPrivate: 'kBluetoothPrivate',
  bookmarks: 'kBookmark',
  certificateProvider: 'kCertificateProvider',
  clipboardRead: 'kClipboardRead',
  clipboardWrite: 'kClipboardWrite',
  contentSettings: 'kContentSettings',
  debugger: 'kDebugger',
  declarativeNetRequest: 'kDeclarativeNetRequest',
  declarativeNetRequestFeedback: 'kDeclarativeNetRequestFeedback',
  declarativeWebRequest: 'kDeclarativeWebRequest',
  desktopCapture: 'kDesktopCapture',
  documentScan: 'kDocumentScan',
  downloads: 'kDownloads',
  'downloads.open': 'kDownloadsOpen',
  'enterprise.deviceAttributes': 'kEnterpriseDeviceAttributes',
  'enterprise.hardwarePlatform': 'kEnterpriseHardwarePlatform',
  'enterprise.kioskInput': 'kEnterpriseKioskInput',
  'enterprise.login': 'kEnterpriseLogin',
  'enterprise.networkingAttributes': 'kEnterpriseNetworkingAttributes',
  'enterprise.platformKeys': 'kEnterprisePlatformKeys',
  'enterprise.remoteApps': 'kEnterpriseRemoteApps',
  'enterprise.reportingPrivate': 'kEnterpriseReportingPrivate',
  'enterprise.webrtc': 'kEnterpriseWebrtc',
  favicon: 'kFavicon',
  'fileSystem.directory': 'kFileSystemDirectory',
  'fileSystem.write': 'kFileSystemWrite',
  geolocation: 'kGeolocation',
  history: 'kHistory',
  'identity.email': 'kIdentityEmail',
  input: 'kInput',
  login: 'kLogin',
  loginScreenStorage: 'kLoginScreenStorage',
  loginScreenUi: 'kLoginScreenUi',
  management: 'kManagement',
  mdns: 'kMDns',
  nativeMessaging: 'kNativeMessaging',
  'networking.onc': 'kNetworkingOnc',
  networkingPrivate: 'kNetworkingPrivate',
  notifications: 'kNotifications',
  'omnibox.directInput': 'kOmniboxDirectInput',
  'os.attached_device_info': 'kChromeOSAttachedDeviceInfo',
  'os.bluetooth_peripherals_info': 'kChromeOSBluetoothPeripheralsInfo',
  'os.diagnostics': 'kChromeOSDiagnostics',
  'os.diagnostics.network_info_mlab': 'kChromeOSDiagnosticsNetworkInfoForMlab',
  'os.events': 'kChromeOSEvents',
  'os.management.audio': 'kChromeOSManagementAudio',
  'os.telemetry': 'kChromeOSTelemetry',
  'os.telemetry.network_info': 'kChromeOSTelemetryNetworkInformation',
  'os.telemetry.serial_number': 'kChromeOSTelemetrySerialNumber',
  passwordsPrivate: 'kPasswordsPrivate',
  platformKeys: 'kPlatformKeys',
  printing: 'kPrinting',
  printingMetrics: 'kPrintingMetrics',
  privacy: 'kPrivacy',
  processes: 'kProcesses',
  readingList: 'kReadingList',
  serial: 'kSerial',
  sessions: 'kSessions',
  settingsPrivate: 'kSettingsPrivate',
  speechRecognitionPrivate: 'kSpeechRecognitionPrivate',
  syncFileSystem: 'kSyncFileSystem',
  'system.storage': 'kSystemStorage',
  tabGroups: 'kTabGroups',
  tabs: 'kTab',
  topSites: 'kTopSites',
  transientBackground: 'kTransientBackground',
  ttsEngine: 'kTtsEngine',
  u2fDevices: 'kU2fDevices',
  usersPrivate: 'kUsersPrivate',
  videoCapture: 'kVideoCapture',
  vpnProvider: 'kVpnProvider',
  wallpaper: 'kWallpaper',
  webAuthenticationProxy: 'kWebAuthenticationProxy',
  webNavigation: 'kWebNavigation'
}

/**
 * Permissions Chrome flags `kFlagImpliesFullURLAccess`: they make the prompt say "Read and change
 * all your data on all websites" even without any host permission.
 */
const IMPLIES_FULL_URL_ACCESS = new Set(['debugger', 'pageCapture', 'tabCapture', 'proxy'])

// ---------------------------------------------------------------------------
// Rule table (chrome_permission_message_rules.cc, GetAllRules, same order)
// ---------------------------------------------------------------------------

interface PermissionEntry {
  id: PermissionId
  /** Host name, vendor name, home page host... `''` for plain permissions. */
  parameter: string
}

type Formatter = (used: PermissionEntry[]) => PermissionWarning

interface Rule {
  format: Formatter
  required: PermissionId[]
  optional: PermissionId[]
}

function plain(message: string): Formatter {
  return () => ({ message, details: [] })
}

function singleParameter(template: string): Formatter {
  return (used) => ({ message: format(template, used[0]?.parameter ?? ''), details: [] })
}

function spaceSeparatedList(one: string, many: string): Formatter {
  return (used) => {
    const params = used.map((p) => p.parameter)
    return { message: format(params.length === 1 ? one : many, params.join(' ')), details: [] }
  }
}

const MAX_HOSTS_IN_MAIN_MESSAGE = 3

function hostList(one: string, two: string, three: string, many: string): Formatter {
  return (used) => {
    const hosts = used.map((p) => p.parameter)
    const inline = hosts.length <= MAX_HOSTS_IN_MAIN_MESSAGE
    const names = hosts.map((host) =>
      host.startsWith('*.')
        ? format(inline ? S.HOST_AND_SUBDOMAIN : S.HOST_AND_SUBDOMAIN_LIST, host.slice(2))
        : host
    )
    switch (names.length) {
      case 1:
        return { message: format(one, names[0]), details: [] }
      case 2:
        return { message: format(two, names[0], names[1]), details: [] }
      case 3:
        return { message: format(three, names[0], names[1], names[2]), details: [] }
      default:
        return { message: many, details: names }
    }
  }
}

const usbDevices: Formatter = (used) => {
  if (used.length === 1) {
    const [permission] = used
    if (permission.id === 'kUsbDevice')
      return { message: format(S.USB_DEVICE, permission.parameter), details: [] }
    if (permission.id === 'kUsbDeviceUnknownProduct')
      return { message: format(S.USB_DEVICE_UNKNOWN_PRODUCT, permission.parameter), details: [] }
    return { message: S.USB_DEVICE_UNKNOWN_VENDOR, details: [] }
  }
  const details = used.filter((p) => p.id === 'kUsbDevice').map((p) => p.parameter)
  for (const p of used.filter((p) => p.id === 'kUsbDeviceUnknownProduct'))
    details.push(format(S.USB_DEVICE_LIST_ITEM_UNKNOWN_PRODUCT, p.parameter))
  if (used.some((p) => p.id === 'kUsbDeviceUnknownVendor'))
    details.push(S.USB_DEVICE_LIST_ITEM_UNKNOWN_VENDOR)
  return { message: S.USB_DEVICE_LIST, details }
}

/** Platform hint for the one message that differs by OS (enterprise.reportingPrivate). */
export type WarningPlatform = 'win' | 'mac' | 'linux' | 'other'

const RULES = new Map<WarningPlatform, Rule[]>()

function rules(platform: WarningPlatform): Rule[] {
  let table = RULES.get(platform)
  if (!table) {
    table = buildRules(platform)
    RULES.set(platform, table)
  }
  return table
}

function buildRules(platform: WarningPlatform): Rule[] {
  const r = (format: Formatter, required: PermissionId[], optional: PermissionId[] = []): Rule => ({
    format,
    required,
    optional
  })
  const enterpriseReporting =
    platform === 'win'
      ? S.ENTERPRISE_REPORTING_PRIVATE_WIN
      : platform === 'mac' || platform === 'linux'
        ? S.ENTERPRISE_REPORTING_PRIVATE_LINUX_AND_MACOS
        : S.ENTERPRISE_REPORTING_PRIVATE
  return [
    // Full access permission messages.
    r(plain(S.DEBUGGER), ['kDebugger']),
    r(
      plain(S.FULL_ACCESS),
      ['kFullAccess'],
      [
        'kDeclarativeWebRequest',
        'kDeclarativeNetRequestFeedback',
        'kFavicon',
        'kHostsAll',
        'kHostsAllReadOnly',
        'kProcesses',
        'kTab',
        'kTopSites',
        'kWebNavigation',
        'kDeclarativeNetRequest'
      ]
    ),

    // Hosts permission messages.
    r(
      plain(S.ALL_HOSTS),
      ['kHostsAll'],
      [
        'kDeclarativeWebRequest',
        'kDeclarativeNetRequestFeedback',
        'kFavicon',
        'kHostsAllReadOnly',
        'kHostReadOnly',
        'kHostReadWrite',
        'kProcesses',
        'kTab',
        'kTopSites',
        'kWebNavigation',
        'kDeclarativeNetRequest',
        'kWebAuthenticationProxy'
      ]
    ),
    r(
      plain(S.ALL_HOSTS),
      ['kWebAuthenticationProxy'],
      [
        'kDeclarativeWebRequest',
        'kDeclarativeNetRequestFeedback',
        'kFavicon',
        'kHostsAllReadOnly',
        'kHostReadOnly',
        'kHostReadWrite',
        'kProcesses',
        'kTab',
        'kTopSites',
        'kWebNavigation',
        'kDeclarativeNetRequest'
      ]
    ),
    r(
      plain(S.ALL_HOSTS_READ_ONLY),
      ['kHostsAllReadOnly'],
      [
        'kDeclarativeNetRequestFeedback',
        'kFavicon',
        'kHostReadOnly',
        'kProcesses',
        'kTab',
        'kTopSites',
        'kWebNavigation'
      ]
    ),
    r(hostList(S.ONE_HOST, S.TWO_HOSTS, S.THREE_HOSTS, S.HOSTS_LIST), ['kHostReadWrite']),
    r(
      hostList(
        S.ONE_HOST_READ_ONLY,
        S.TWO_HOSTS_READ_ONLY,
        S.THREE_HOSTS_READ_ONLY,
        S.HOSTS_LIST_READ_ONLY
      ),
      ['kHostReadOnly']
    ),

    // New tab page permission is fairly highly used so rank it quite highly.
    r(plain(S.NEW_TAB_PAGE_OVERRIDE), ['kNewTabPageOverride']),

    // Video and audio capture.
    r(plain(S.AUDIO_AND_VIDEO_CAPTURE), ['kAudioCapture', 'kVideoCapture']),
    r(plain(S.AUDIO_CAPTURE), ['kAudioCapture']),
    r(plain(S.VIDEO_CAPTURE), ['kVideoCapture']),
    r(plain(S.SPEECH_RECOGNITION), ['kSpeechRecognitionPrivate']),
    r(plain(S.GEOLOCATION), ['kGeolocation']),

    // History-related permission messages.
    r(
      plain(S.HISTORY_WRITE_ON_ALL_DEVICES),
      ['kHistory'],
      [
        'kDeclarativeNetRequestFeedback',
        'kFavicon',
        'kProcesses',
        'kTab',
        'kTopSites',
        'kWebNavigation'
      ]
    ),
    r(
      plain(S.HISTORY_READ_ON_ALL_DEVICES),
      ['kTab', 'kSessions'],
      ['kDeclarativeNetRequestFeedback', 'kFavicon', 'kProcesses', 'kTopSites', 'kWebNavigation']
    ),
    r(
      plain(S.HISTORY_READ),
      ['kTab'],
      ['kDeclarativeNetRequestFeedback', 'kFavicon', 'kProcesses', 'kTopSites', 'kWebNavigation']
    ),
    r(
      plain(S.HISTORY_READ),
      ['kProcesses'],
      ['kDeclarativeNetRequestFeedback', 'kFavicon', 'kTopSites', 'kWebNavigation']
    ),
    r(
      plain(S.HISTORY_READ),
      ['kWebNavigation'],
      ['kDeclarativeNetRequestFeedback', 'kFavicon', 'kTopSites']
    ),
    r(plain(S.HISTORY_READ), ['kDeclarativeNetRequestFeedback'], ['kFavicon', 'kTopSites']),
    r(plain(S.FAVICON), ['kFavicon']),
    r(plain(S.TOPSITES), ['kTopSites']),
    r(plain(S.PRINTING), ['kPrinting']),
    r(plain(S.PRINTING_METRICS), ['kPrintingMetrics']),
    r(plain(S.DECLARATIVE_WEB_REQUEST), ['kDeclarativeWebRequest']),
    r(plain(S.DECLARATIVE_NET_REQUEST), ['kDeclarativeNetRequest']),

    // Messages generated by the sockets permission.
    r(plain(S.SOCKET_ANY_HOST), ['kSocketAnyHost'], ['kSocketDomainHosts', 'kSocketSpecificHosts']),
    r(spaceSeparatedList(S.SOCKET_HOSTS_IN_DOMAIN, S.SOCKET_HOSTS_IN_DOMAINS), [
      'kSocketDomainHosts'
    ]),
    r(spaceSeparatedList(S.SOCKET_SPECIFIC_HOST, S.SOCKET_SPECIFIC_HOSTS), [
      'kSocketSpecificHosts'
    ]),

    // Devices-related messages.
    r(usbDevices, ['kUsbDevice'], ['kUsbDeviceUnknownProduct', 'kUsbDeviceUnknownVendor']),
    r(usbDevices, ['kUsbDeviceUnknownProduct'], ['kUsbDeviceUnknownVendor']),
    r(usbDevices, ['kUsbDeviceUnknownVendor']),
    r(plain(S.BLUETOOTH_SERIAL), ['kBluetooth', 'kSerial'], ['kBluetoothDevices']),
    r(plain(S.BLUETOOTH), ['kBluetooth'], ['kBluetoothDevices']),
    r(
      plain(S.BLUETOOTH_DEVICES),
      ['kBluetoothDevices'],
      ['kBluetoothSocket', 'kBluetoothLowEnergy', 'kBluetoothPeripheral']
    ),
    r(
      plain(S.BLUETOOTH_DEVICES_SOCKET),
      ['kBluetoothSocket'],
      ['kBluetoothLowEnergy', 'kBluetoothPeripheral']
    ),
    r(plain(S.BLUETOOTH_DEVICES_LOW_ENERGY), ['kBluetoothLowEnergy'], ['kBluetoothPeripheral']),
    r(plain(S.BLUETOOTH_DEVICES_PERIPHERAL), ['kBluetoothPeripheral']),
    r(plain(S.BLUETOOTH_PRIVATE), ['kBluetoothPrivate']),
    r(plain(S.SERIAL), ['kSerial']),
    r(plain(S.U2F_DEVICES), ['kU2fDevices']),
    r(plain(S.NOTIFICATIONS), ['kNotifications']),

    // Accessibility features.
    r(plain(S.ACCESSIBILITY_FEATURES_READ_MODIFY), [
      'kAccessibilityFeaturesModify',
      'kAccessibilityFeaturesRead'
    ]),
    r(plain(S.ACCESSIBILITY_FEATURES_MODIFY), ['kAccessibilityFeaturesModify']),
    r(plain(S.ACCESSIBILITY_FEATURES_READ), ['kAccessibilityFeaturesRead']),

    // Media galleries permissions.
    r(
      plain(S.MEDIA_GALLERIES_READ_WRITE_DELETE),
      ['kMediaGalleriesAllGalleriesCopyTo', 'kMediaGalleriesAllGalleriesDelete'],
      ['kMediaGalleriesAllGalleriesRead']
    ),
    r(
      plain(S.MEDIA_GALLERIES_READ_WRITE),
      ['kMediaGalleriesAllGalleriesCopyTo'],
      ['kMediaGalleriesAllGalleriesRead']
    ),
    r(
      plain(S.MEDIA_GALLERIES_READ_DELETE),
      ['kMediaGalleriesAllGalleriesDelete'],
      ['kMediaGalleriesAllGalleriesRead']
    ),
    r(plain(S.MEDIA_GALLERIES_READ), ['kMediaGalleriesAllGalleriesRead']),

    // File system permissions.
    r(plain(S.FILE_SYSTEM_WRITE_DIRECTORY), ['kFileSystemWrite', 'kFileSystemDirectory']),
    r(plain(S.FILE_SYSTEM_DIRECTORY), ['kFileSystemDirectory']),

    // Network-related permissions.
    r(plain(S.NETWORKING_PRIVATE), ['kNetworkingOnc'], ['kNetworkingPrivate']),
    r(plain(S.NETWORKING_PRIVATE), ['kNetworkingPrivate']),
    r(plain(S.NETWORK_STATE), ['kNetworkState']),
    r(plain(S.VPN), ['kVpnProvider']),
    r(singleParameter(S.HOME_PAGE_SETTING_OVERRIDE), ['kHomepage']),
    r(singleParameter(S.SEARCH_SETTINGS_OVERRIDE), ['kSearchProvider']),
    r(singleParameter(S.START_PAGE_SETTING_OVERRIDE), ['kStartupPages']),

    r(plain(S.BOOKMARKS), ['kBookmark']),
    r(plain(S.READING_LIST), ['kReadingList']),
    r(plain(S.CLIPBOARD_READWRITE), ['kClipboardRead', 'kClipboardWrite']),
    r(plain(S.CLIPBOARD), ['kClipboardRead']),
    r(plain(S.CLIPBOARD_WRITE), ['kClipboardWrite']),
    r(plain(S.DESKTOP_CAPTURE), ['kDesktopCapture']),
    r(plain(S.DOWNLOADS), ['kDownloads']),
    r(plain(S.DOWNLOADS_OPEN), ['kDownloadsOpen']),
    r(plain(S.IDENTITY_EMAIL), ['kIdentityEmail']),
    r(plain(S.SYSTEM_STORAGE), ['kSystemStorage']),
    r(plain(S.CONTENT_SETTINGS), ['kContentSettings']),
    r(plain(S.DOCUMENT_SCAN), ['kDocumentScan']),
    r(plain(S.INPUT), ['kInput']),
    r(plain(S.MANAGEMENT), ['kManagement']),
    r(plain(S.MDNS), ['kMDns']),
    r(plain(S.NATIVE_MESSAGING), ['kNativeMessaging']),
    r(plain(S.PRIVACY), ['kPrivacy']),
    r(plain(S.SYNCFILESYSTEM), ['kSyncFileSystem']),
    r(plain(S.TAB_GROUPS), ['kTabGroups']),
    r(plain(S.TTS_ENGINE), ['kTtsEngine']),
    r(plain(S.WALLPAPER), ['kWallpaper']),
    r(plain(S.PLATFORMKEYS), ['kPlatformKeys']),
    r(plain(S.CERTIFICATEPROVIDER), ['kCertificateProvider']),
    r(plain(S.ACTIVITY_LOG_PRIVATE), ['kActivityLogPrivate']),
    r(plain(S.SETTINGS_PRIVATE), ['kSettingsPrivate']),
    r(plain(S.AUTOFILL_PRIVATE), ['kAutofillPrivate']),
    r(plain(S.PASSWORDS_PRIVATE), ['kPasswordsPrivate']),
    r(plain(S.USERS_PRIVATE), ['kUsersPrivate']),
    r(plain(enterpriseReporting), ['kEnterpriseReportingPrivate']),
    r(plain(S.ENTERPRISE_HARDWARE_PLATFORM), ['kEnterpriseHardwarePlatform']),
    r(plain(S.ENTERPRISE_DEVICE_ATTRIBUTES), ['kEnterpriseDeviceAttributes']),
    r(plain(S.ENTERPRISE_WEBRTC), ['kEnterpriseWebrtc']),
    r(plain(S.ENTERPRISE_KIOSK_INPUT), ['kEnterpriseKioskInput']),
    r(plain(S.ENTERPRISE_LOGIN), ['kEnterpriseLogin']),
    r(plain(S.ENTERPRISE_NETWORKING_ATTRIBUTES), ['kEnterpriseNetworkingAttributes']),
    r(plain(S.ENTERPRISE_PLATFORMKEYS), ['kEnterprisePlatformKeys']),
    r(plain(S.OMNIBOX_DIRECT_INPUT), ['kOmniboxDirectInput']),
    r(plain(S.LOGIN), ['kLogin']),
    r(plain(S.LOGIN_SCREEN_UI), ['kLoginScreenUi']),
    r(plain(S.LOGIN_SCREEN_STORAGE), ['kLoginScreenStorage']),
    r(plain(S.ENTERPRISE_REMOTE_APPS), ['kEnterpriseRemoteApps']),
    r(plain(S.TRANSIENT_BACKGROUND), ['kTransientBackground']),

    // Telemetry System Extension permission messages.
    r(plain(S.CHROMEOS_ATTACHED_DEVICE_INFO), ['kChromeOSAttachedDeviceInfo']),
    r(plain(S.CHROMEOS_BLUETOOTH_PERIPHERALS_INFO), ['kChromeOSBluetoothPeripheralsInfo']),
    r(plain(S.CHROMEOS_DIAGNOSTICS), ['kChromeOSDiagnostics']),
    r(plain(S.CHROMEOS_DIAGNOSTICS_NETWORK_INFO_FOR_MLAB), [
      'kChromeOSDiagnosticsNetworkInfoForMlab'
    ]),
    r(plain(S.CHROMEOS_EVENTS), ['kChromeOSEvents']),
    r(plain(S.CHROMEOS_MANAGEMENT_AUDIO), ['kChromeOSManagementAudio']),
    r(plain(S.CHROMEOS_TELEMETRY), ['kChromeOSTelemetry']),
    r(plain(S.CHROMEOS_TELEMETRY_SERIAL_NUMBER), ['kChromeOSTelemetrySerialNumber']),
    r(plain(S.CHROMEOS_TELEMETRY_NETWORK_INFORMATION), ['kChromeOSTelemetryNetworkInformation'])
  ]
}

/**
 * Chrome's GetPermissionMessagesHelper: apply the rules in order; a rule that fires consumes its
 * required ids plus whichever of its optional ids are present.
 */
export function warningsForPermissionIds(
  entries: readonly PermissionEntry[],
  platform: WarningPlatform = 'other'
): PermissionWarning[] {
  let remaining = sortEntries([...entries])
  const messages: PermissionWarning[] = []
  for (const rule of rules(platform)) {
    if (!rule.required.every((id) => remaining.some((e) => e.id === id))) continue
    const all = new Set<PermissionId>([...rule.required, ...rule.optional])
    const used = remaining.filter((e) => all.has(e.id))
    messages.push(rule.format(used))
    remaining = remaining.filter((e) => !all.has(e.id))
  }
  return messages
}

/** `std::set<PermissionID>` order: by id, then by parameter (UTF-16 code units). */
function sortEntries(entries: PermissionEntry[]): PermissionEntry[] {
  const seen = new Set<string>()
  const unique = entries.filter((e) => {
    const key = `${e.id}\u0000${e.parameter}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.sort((a, b) =>
    a.id !== b.id
      ? a.id < b.id
        ? -1
        : 1
      : a.parameter < b.parameter
        ? -1
        : a.parameter > b.parameter
          ? 1
          : 0
  )
}

// ---------------------------------------------------------------------------
// Manifest -> permission ids
// ---------------------------------------------------------------------------

/** A parsed match pattern, the subset of `URLPattern` the warnings need. */
export interface MatchPattern {
  scheme: string
  host: string
  matchSubdomains: boolean
  matchAllUrls: boolean
}

const HOST_PERMISSION_SCHEMES = new Set([
  '*',
  'http',
  'https',
  'file',
  'ftp',
  'ws',
  'wss',
  'chrome'
])
const PATTERN_RE = /^([a-zA-Z*][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)$/

/**
 * `URLPattern::Parse` for host-permission purposes. Returns null for anything Chrome rejects (a
 * missing path, a wildcard in the middle of the host, an unsupported scheme), which Chrome turns
 * into an install warning and ignores.
 */
export function parseMatchPattern(text: string): MatchPattern | null {
  if (text === '<all_urls>')
    return { scheme: '*', host: '', matchSubdomains: true, matchAllUrls: true }
  const match = PATTERN_RE.exec(text)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  if (!HOST_PERMISSION_SCHEMES.has(scheme)) return null
  let host = match[2].toLowerCase()
  if (scheme === 'file') {
    if (host !== '' && host !== '*') return null
    return { scheme, host: '', matchSubdomains: false, matchAllUrls: false }
  }
  let matchSubdomains = false
  if (host === '*') {
    matchSubdomains = true
    host = ''
  } else if (host.startsWith('*.')) {
    matchSubdomains = true
    host = host.slice(2)
  }
  if (host.includes('*')) return null
  if (host === '' && !matchSubdomains) return null
  // Port suffixes take no part in the warning; drop them like URLPattern's host() accessor does.
  const colon = host.lastIndexOf(':')
  if (colon > 0 && /^\d+$|^\*$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  if (host.startsWith('[')) return { scheme, host, matchSubdomains, matchAllUrls: false }
  return { scheme, host: toAsciiHost(host), matchSubdomains, matchAllUrls: false }
}

/** IDN hosts are shown as punycode, as Chrome's FormatUrlForSecurityDisplay does. */
function toAsciiHost(host: string): string {
  try {
    return new URL(`http://${host}/`).hostname
  } catch {
    return host
  }
}

// A compact stand-in for Chromium's registry-controlled-domain (public suffix) list. Two-letter
// labels are country codes; the generic list covers the suffixes extensions realistically use in
// `*.<suffix>` patterns or as trailing labels of concrete hosts. Private registries (github.io,
// blogspot.com, ...) are deliberately absent: Chrome excludes them here too.
function words(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter((w) => w.length > 0))
}

const GENERIC_TLDS = words(`
  com net org edu gov mil int info biz name pro mobi app
  dev io co me tv cc ai xyz online site tech store shop
  blog cloud page live news media games game wiki academy agency
  art bank business center chat club codes company design digital
  directory download email engineering events expert finance fm fun
  gallery global group guru health help host house inc institute
  international jobs land legal life link llc ltd market money
  movie music network ninja one photo photos pics pictures place
  plus press rocks run school science services social software
  solutions space studio style support systems team today tools top
  travel university video vip watch website work works world zone
  aero asia cat coop jobs museum tel travel xxx post arpa
`)

const SECOND_LEVEL_REGISTRIES = words(`
  co.uk org.uk me.uk ltd.uk plc.uk net.uk sch.uk ac.uk gov.uk nhs.uk
  com.au net.au org.au edu.au gov.au id.au asn.au
  co.nz net.nz org.nz govt.nz ac.nz school.nz geek.nz gen.nz kiwi.nz
  co.jp ne.jp or.jp ac.jp go.jp ad.jp ed.jp gr.jp lg.jp
  co.kr ne.kr or.kr ac.kr go.kr re.kr pe.kr
  com.cn net.cn org.cn gov.cn edu.cn ac.cn
  com.tw net.tw org.tw edu.tw gov.tw idv.tw
  com.hk net.hk org.hk edu.hk gov.hk idv.hk
  com.sg net.sg org.sg edu.sg gov.sg per.sg
  co.in net.in org.in firm.in gen.in ind.in ac.in edu.in gov.in res.in
  com.br net.br org.br gov.br edu.br art.br blog.br eco.br
  com.mx net.mx org.mx gob.mx edu.mx
  com.ar net.ar org.ar gob.ar edu.ar
  co.za net.za org.za web.za gov.za ac.za
  com.tr net.tr org.tr gov.tr edu.tr gen.tr web.tr
  com.ru net.ru org.ru msk.ru spb.ru
  com.ua net.ua org.ua in.ua kiev.ua gov.ua
  com.pl net.pl org.pl edu.pl gov.pl waw.pl
  co.il org.il net.il ac.il gov.il muni.il
  co.id or.id web.id ac.id go.id my.id
  com.my net.my org.my edu.my gov.my
  com.ph net.ph org.ph edu.ph gov.ph
  com.vn net.vn org.vn edu.vn gov.vn
  co.th in.th or.th ac.th go.th
  com.sa net.sa org.sa edu.sa gov.sa
  com.eg net.eg org.eg edu.eg gov.eg
  com.ng net.ng org.ng edu.ng gov.ng
  co.ke or.ke ne.ke ac.ke go.ke
  com.pk net.pk org.pk edu.pk gov.pk
  com.bd net.bd org.bd edu.bd gov.bd
  com.co net.co org.co edu.co gov.co
  com.pe net.pe org.pe edu.pe gob.pe
  com.ve net.ve org.ve co.ve gob.ve
  com.ec net.ec org.ec edu.ec gob.ec
  com.uy net.uy org.uy edu.uy gub.uy
  com.py net.py org.py edu.py gov.py
  com.bo net.bo org.bo edu.bo gob.bo
  com.do net.do org.do edu.do gob.do
  com.gt net.gt org.gt edu.gt gob.gt
  com.es nom.es org.es edu.es gob.es
  com.pt edu.pt gov.pt org.pt net.pt
  co.at or.at ac.at gv.at
  com.de co.de
  co.it edu.it gov.it
  com.fr asso.fr nom.fr gouv.fr
  co.nl com.nl
  com.se org.se
  co.no priv.no
  com.gr net.gr org.gr edu.gr gov.gr
  com.ro org.ro nt.ro www.ro
  co.hu org.hu info.hu
  com.cz co.cz
  co.rs org.rs edu.rs in.rs
  com.hr iz.hr from.hr name.hr
  co.ca com.ca gc.ca
  com.ch net.ch org.ch
  co.ir net.ir org.ir ac.ir gov.ir
  com.kz org.kz edu.kz gov.kz
  com.ge org.ge edu.ge gov.ge
  com.by org.by gov.by
  com.lb org.lb edu.lb gov.lb
  com.jo org.jo edu.jo gov.jo
  com.kw org.kw edu.kw gov.kw
  com.qa org.qa edu.qa gov.qa
  com.bh org.bh edu.bh gov.bh
  com.om org.om edu.om gov.om
  co.ae net.ae org.ae ac.ae gov.ae
  com.lk org.lk edu.lk gov.lk
  com.np org.np edu.np gov.np
  com.mm org.mm edu.mm gov.mm
  com.kh org.kh edu.kh gov.kh
  com.mt org.mt edu.mt gov.mt
  com.cy org.cy ac.cy gov.cy
  com.ee edu.ee gov.ee
  com.lv org.lv edu.lv gov.lv
  com.lt
  co.bw co.zm co.zw co.tz co.ug co.mz co.ao
  com.gh org.gh edu.gh gov.gh
  com.et org.et edu.et gov.et
  com.tn org.tn gov.tn
  co.ma net.ma org.ma ac.ma gov.ma
  com.dz org.dz edu.dz gov.dz
  com.ly org.ly edu.ly gov.ly
  com.sd org.sd edu.sd gov.sd
`)

/**
 * The registry ("effective TLD") suffix of a host, or `''` when the registry is unknown or the
 * host is nothing but a registry (`com`, `co.uk`). Mirrors `GetRegistryLength(host,
 * EXCLUDE_UNKNOWN_REGISTRIES, EXCLUDE_PRIVATE_REGISTRIES)` over the compact table above.
 */
export function registryOf(host: string): string {
  const labels = host.split('.').filter((l) => l.length > 0)
  if (labels.length < 2) return ''
  const last2 = labels.slice(-2).join('.')
  if (SECOND_LEVEL_REGISTRIES.has(last2)) return labels.length >= 3 ? last2 : ''
  const last = labels[labels.length - 1]
  if (/^[a-z]{2}$/.test(last) || GENERIC_TLDS.has(last)) return last
  return ''
}

/** `URLPattern::MatchesEffectiveTld`: `*.com` and friends grant access to every site. */
export function matchesEffectiveTld(pattern: MatchPattern): boolean {
  if (pattern.matchAllUrls || (pattern.matchSubdomains && pattern.host === '')) return true
  if (!pattern.matchSubdomains) return false
  if (registryOf(pattern.host) !== '') return false
  return registryOf(`notatld.${pattern.host}`) !== ''
}

function rcdBetterThan(a: string, b: string): boolean {
  if (a === b) return false
  if (a === 'com') return true
  if (a === 'net') return b !== 'com'
  if (a === 'org') return b !== 'com' && b !== 'net'
  return false
}

/**
 * `permission_message_util::GetDistinctHosts(patterns, include_rcd = true, exclude_file = true)`:
 * one entry per host, `*.` kept for subdomain wildcards, sibling registries collapsed onto the
 * best one (`google.com` + `google.de` -> `google.com`), sorted.
 */
export function distinctHosts(patterns: readonly MatchPattern[]): string[] {
  const best: Array<[string, string]> = []
  for (const pattern of patterns) {
    if (pattern.scheme === 'file') continue
    let host = pattern.host
    if (pattern.matchSubdomains) host = `*.${host}`
    const registry = registryOf(pattern.host)
    let rcd = ''
    if (registry !== '') {
      rcd = registry
      host = host.slice(0, host.length - registry.length)
    }
    const existing = best.find(([h]) => h === host)
    if (existing) {
      if (rcdBetterThan(rcd, existing[1])) existing[1] = rcd
    } else {
      best.push([host, rcd])
    }
  }
  return [...new Set(best.map(([host, rcd]) => host + rcd))].sort()
}

function strings(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : []
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host
}

function hostOf(url: string): string {
  try {
    return stripWww(new URL(url).hostname)
  } catch {
    return url
  }
}

/**
 * The permission ids of a manifest's required permissions: API permissions, permissions implied
 * by other manifest keys, and one host id per distinct host (or `kHostsAll`).
 */
export function permissionIdsForManifest(manifest: PermissionWarningSource): PermissionEntry[] {
  const ids: PermissionEntry[] = []
  const add = (id: PermissionId, parameter = ''): void => {
    ids.push({ id, parameter })
  }
  const mv3 = (manifest.manifest_version ?? 2) >= 3
  const hostStrings: string[] = []
  let impliesFullUrlAccess = false

  for (const entry of manifest.permissions ?? []) {
    if (typeof entry === 'string') {
      if (IMPLIES_FULL_URL_ACCESS.has(entry)) impliesFullUrlAccess = true
      const id = API_PERMISSION_IDS[entry]
      if (id) add(id)
      // MV2 mixes host patterns into `permissions`; anything that is neither a known API name
      // nor a pattern is an unknown permission Chrome warns about and ignores.
      else if (!mv3) hostStrings.push(entry)
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    // Structured permissions: {"fileSystem": ["write", "directory"]}, {"usbDevices": [...]},
    // {"mediaGalleries": ["read", "allAutoDetected"]}.
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (key === 'fileSystem') {
        for (const sub of strings(value)) {
          const id = API_PERMISSION_IDS[`fileSystem.${sub}`]
          if (id) add(id)
        }
      } else if (key === 'mediaGalleries') {
        const subs = new Set(strings(value))
        if (subs.has('allAutoDetected')) {
          if (subs.has('read')) add('kMediaGalleriesAllGalleriesRead')
          if (subs.has('copyTo')) add('kMediaGalleriesAllGalleriesCopyTo')
          if (subs.has('delete')) add('kMediaGalleriesAllGalleriesDelete')
        }
      } else if (key === 'usbDevices' && Array.isArray(value) && value.length > 0) {
        // Chrome resolves vendor/product ids against its USB id table; without it every device
        // is reported the way Chrome reports an unknown vendor.
        add('kUsbDeviceUnknownVendor')
      } else if (key === 'socket') {
        for (const rule of strings(value)) {
          const host = rule.split(':')[1] ?? ''
          if (host === '' || host === '*') add('kSocketAnyHost')
          else if (host.startsWith('*.')) add('kSocketDomainHosts', host.slice(2))
          else add('kSocketSpecificHosts', host)
        }
      } else {
        const id = API_PERMISSION_IDS[key]
        if (id) add(id)
      }
    }
  }

  if (mv3) hostStrings.push(...strings(manifest.host_permissions))

  // Permissions other manifest keys imply.
  if (typeof manifest.devtools_page === 'string') impliesFullUrlAccess = true
  if (manifest.chrome_url_overrides?.newtab) add('kNewTabPageOverride')
  const overrides = manifest.chrome_settings_overrides
  if (overrides?.search_provider?.search_url)
    add('kSearchProvider', hostOf(overrides.search_provider.search_url))
  if (overrides?.startup_pages?.[0]) add('kStartupPages', hostOf(overrides.startup_pages[0]))
  if (overrides?.homepage) add('kHomepage', hostOf(overrides.homepage))
  if (manifest.bluetooth && typeof manifest.bluetooth === 'object') {
    add('kBluetooth')
    if (manifest.bluetooth.uuids?.length) add('kBluetoothDevices')
    if (manifest.bluetooth.socket) add('kBluetoothSocket')
    if (manifest.bluetooth.low_energy) add('kBluetoothLowEnergy')
    if (manifest.bluetooth.peripheral) add('kBluetoothPeripheral')
  }

  // Platform apps use isolated storage, so Chrome never warns about their hosts.
  const app = manifest.app as { background?: unknown } | undefined
  if (app && typeof app === 'object' && 'background' in app) return ids

  const explicit = hostStrings.map(parseMatchPattern).filter((p): p is MatchPattern => p !== null)
  const scriptable: MatchPattern[] = []
  for (const script of manifest.content_scripts ?? []) {
    for (const text of strings(script?.matches)) {
      const pattern = parseMatchPattern(text)
      if (pattern && pattern.scheme !== 'chrome') scriptable.push(pattern)
    }
  }
  const effective = [...explicit, ...scriptable]

  const warnAllHosts = impliesFullUrlAccess || effective.some(matchesEffectiveTld)
  if (warnAllHosts) {
    add('kHostsAll')
    return ids
  }
  const regular: MatchPattern[] = []
  for (const pattern of effective) {
    if (pattern.scheme === 'chrome') {
      // chrome://favicon is the only chrome:// host Chrome lets extensions ask for.
      if (pattern.host === 'favicon') add('kFavicon')
      continue
    }
    regular.push(pattern)
  }
  for (const host of distinctHosts(regular)) add('kHostReadWrite', host)
  return ids
}

/**
 * The install prompt's warning lines for a manifest, in Chrome's order. Empty when Chrome would
 * show none (an extension with only `storage` and `activeTab`, for example).
 */
export function permissionWarnings(
  manifest: PermissionWarningSource,
  platform: WarningPlatform = 'other'
): PermissionWarning[] {
  return warningsForPermissionIds(permissionIdsForManifest(manifest), platform)
}

/** Just the message lines, for hosts that show a flat list. */
export function permissionWarningLines(
  manifest: PermissionWarningSource,
  platform: WarningPlatform = 'other'
): string[] {
  return permissionWarnings(manifest, platform).flatMap((w) => [
    w.message,
    ...w.details.map((d) => `  ${d}`)
  ])
}

/**
 * Warnings the new set adds over the old one: Chrome disables an updated extension until the
 * user re-approves when this is non-empty (the "privilege increase" check).
 */
export function newWarnings(
  before: readonly PermissionWarning[],
  after: readonly PermissionWarning[]
): PermissionWarning[] {
  const seen = new Set(before.map((w) => JSON.stringify([w.message, w.details])))
  return after.filter((w) => !seen.has(JSON.stringify([w.message, w.details])))
}
