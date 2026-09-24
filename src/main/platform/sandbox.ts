/**
 * Whether the app asks Electron for its sandboxed renderer client at startup – `--enable-sandbox`
 * on the browser's command line, before `ready` – and the reason when it does not.
 *
 * Electron evaluates a session's `service-worker` preload scripts – Zenium's `chrome.*` layer for
 * MV3 background workers (`preload/extension.ts`, registered by the extension API host) – from
 * its sandboxed renderer client only, and picks that client for a renderer when `--enable-sandbox`
 * is on the renderer's command line OR `--no-sandbox` is not (`IsSandboxEnabled`,
 * `shell/app/command_line_args.cc`; `ElectronMainDelegate::CreateContentRendererClient`). A launch
 * with `--no-sandbox` – a container without user namespaces, a CI runner, a harness – therefore
 * skips every worker preload, silently: the workers keep the engine's own `chrome.*` (`dom,
 * extension, i18n, management, runtime, scripting, storage, tabs`) and lose `permissions`,
 * `windows`, `alarms`, `debugger`, `contextMenus`, … (`docs/upstream-reports/
 * electron-service-worker-preload-no-sandbox.md`).
 *
 * Electron copies `--enable-sandbox` from the browser's command line to every renderer's and
 * utility process's (`kCommonSwitchNames`), so with it on the browser's the sandboxed client –
 * and with it the worker preload realm – is used for every renderer, the worker-only ones
 * included, whether or not the OS sandbox is on; `--no-sandbox` still turns the OS sandbox off
 * where it has to be. Every web contents of Zenium's runs with `sandbox: true` already, which
 * gives its renderer the very same pair of switches under `--no-sandbox`, so nothing changes
 * for them. The switch is appended by hand rather than through `app.enableSandbox()`: that API
 * also strips `--no-sandbox` from the browser's command line (Electron 44.4.5,
 * `RemoveNoSandboxSwitch`), turning the OS sandbox back on for every process launched after
 * startup and making `app.commandLine.hasSwitch('no-sandbox')` false – more than the worker
 * preloads need, and a launch that passed `--no-sandbox` because its host cannot sandbox would
 * lose the switch it needs.
 *
 * The exception is root on Linux. Electron aborts any of its processes that starts as root with
 * the sandbox "enabled" by that same test (`BasicStartupComplete`, crbug.com/638180): the browser
 * process would pass – the switch lands after its check – but the utility processes it launches
 * fresh (the network service first) would die on it. Root keeps the engine-only workers, with a
 * line saying so; the extension API's startup self-check names the loss again when a worker
 * starts.
 */
export interface SandboxRequest {
  enable: boolean
  /** Why the switch is not appended, for the log; null when it is. */
  reason: string | null
}

/** The switch (`app.commandLine.appendSwitch`), Electron's `switches::kEnableSandbox`. */
export const ENABLE_SANDBOX_SWITCH = 'enable-sandbox'

export function sandboxRequest(input: {
  platform: NodeJS.Platform
  uid: number | null
}): SandboxRequest {
  if (input.platform === 'linux' && input.uid === 0) {
    return {
      enable: false,
      reason:
        'running as root: Electron refuses --enable-sandbox for root (crbug.com/638180), so the service-worker preload cannot run and MV3 extension workers get only the engine’s chrome.*'
    }
  }
  return { enable: true, reason: null }
}
