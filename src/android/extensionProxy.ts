/**
 * `chrome.proxy.settings` on the phone: the honest reading of a setting the extension cannot
 * control here.
 *
 * Chrome's proxy setting is a `types.ChromeSetting` whose value is a `ProxyConfig` (`direct`,
 * `auto_detect`, `pac_script`, `fixed_servers`, `system`). The WebView takes one proxy override
 * per app process (`androidx.webkit.ProxyController`): fixed rules and a bypass list, for every
 * WebView of the process, the private tabs' too, and no PAC script or auto-detect, which is what
 * the VPN extensions set (VeePN, NordVPN and Browsec all set `pac_script`). Until a fixed-rule
 * binding lands, the setting is the system's and `not_controllable`, as Chrome reports a setting
 * an extension may not control: `get` answers what the browser does, `set` checks the value with
 * Chrome's own checks and then fails for anything but the system's settings (the extension
 * shows its connection error, instead of believing it is connected while the traffic goes
 * direct), `clear` has nothing to clear, and `onChange` never fires.
 *
 * The namespace exists for an extension that declared the permission (`NAMESPACE_PERMISSIONS`),
 * so the calls only ever come from one; before it did, `chrome.proxy` was undefined on the phone
 * and the three VPN workers died on `.settings` in their first statements.
 */
import {
  normalizeProxyConfig,
  PROXY_SETTING,
  SYSTEM_PROXY_CONFIG,
  type ProxyConfig
} from '../core/extensions/api/proxy'

export const PROXY_NOT_CONTROLLABLE = 'not_controllable'

export const PROXY_NOT_CONTROLLABLE_ERROR =
  'The proxy setting is not controllable on Zenium for Android: the WebView applies no PAC script or auto-detect configuration, and a fixed-servers override is not bound yet.'

/** The `ChromeSetting` reading: the system's settings, controllable by nobody. */
export interface ProxySettingReading {
  value: ProxyConfig
  levelOfControl: typeof PROXY_NOT_CONTROLLABLE
}

export function proxySettingReading(): ProxySettingReading {
  return { value: { ...SYSTEM_PROXY_CONFIG }, levelOfControl: PROXY_NOT_CONTROLLABLE }
}

/**
 * Answer `chrome.proxy.<method>` as the shim routes a `ChromeSetting`'s call:
 * `(setting, details)`. Throws with the message the call rejects with.
 */
export function answerProxySetting(method: string, args: readonly unknown[]): unknown {
  const [setting, details] = args
  if (setting !== PROXY_SETTING) {
    throw new Error(`chrome.proxy.${String(setting)} is not implemented on Zenium for Android`)
  }
  switch (method) {
    case 'get':
      return proxySettingReading()
    case 'set': {
      const value =
        details !== null && typeof details === 'object' ? Reflect.get(details, 'value') : undefined
      const config = normalizeProxyConfig(value)
      // The system's settings are what the browser has: nothing to change, and true to report.
      if (config.mode === 'system') return undefined
      throw new Error(PROXY_NOT_CONTROLLABLE_ERROR)
    }
    case 'clear':
      return undefined
    default:
      throw new Error(`chrome.proxy.settings.${method} is not implemented on Zenium for Android`)
  }
}
