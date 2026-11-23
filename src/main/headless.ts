/**
 * `zenium --server`: Zenium on a machine with no screen, for AI agents to drive.
 *
 * The browser runs as it always does – windows, tabs, spaces, the MCP server – on Chromium's
 * headless Ozone platform, so nothing is drawn and no X server or Wayland compositor is needed.
 * That platform has to be chosen on the process's own command line (Electron reads
 * `--ozone-platform` before any of the app's code runs, so `appendSwitch` is too late), which is
 * why a launch without it starts itself again with it (`serverRelaunchArgs`). Chromium's own
 * `--headless` is not used: Electron wires it only partly, and a page's DevTools capture then
 * hangs or crashes.
 *
 * Once the browser is up the AI agents' server is turned on, and its endpoint and the token
 * that skips the approval prompt are printed (nobody is there to answer a prompt). With
 * `--sign-in` the machine is linked to the Zenium account by a code printed on stdout, approved
 * from any signed-in browser.
 */
import type { AgentServerStatus, SyncStatus } from '../shared/types'

export const OZONE_PLATFORM_SWITCH = 'ozone-platform'
/** The headless screen's size: a common laptop's, so pages lay out as they would for a person. */
export const SERVER_SCREEN_SIZE = '1920,1080'
/**
 * Set on the restarted process: the pid of the launch that waits for it. The server stops when
 * that process is gone, so stopping the launch (`kill <pid>`, a supervisor) stops the browser.
 */
export const SERVER_PARENT_ENV = 'ZENIUM_SERVER_PARENT'

/**
 * The arguments to start this process again with for a `--server` launch, or null when it can
 * go ahead as it is: not a server launch, not Linux (Ozone is Linux's), or the Ozone platform
 * already named on the command line (a launch that chose its own is left with its choice).
 * `argv` is `process.argv` without the executable.
 */
export function serverRelaunchArgs(
  argv: readonly string[],
  platform: NodeJS.Platform,
  server: boolean
): string[] | null {
  if (!server || platform !== 'linux') return null
  const named = argv.some(
    (arg) => arg === `--${OZONE_PLATFORM_SWITCH}` || arg.startsWith(`--${OZONE_PLATFORM_SWITCH}=`)
  )
  if (named) return null
  return [
    ...argv,
    `--${OZONE_PLATFORM_SWITCH}=headless`,
    `--ozone-override-screen-size=${SERVER_SCREEN_SIZE}`
  ]
}

/** What a `--server` launch says it does on a platform that has no headless mode yet. */
export function serverUnsupportedLine(platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return null
  return `--server runs on Linux only for now; on ${platform} Zenium starts with its windows as usual`
}

/**
 * Call `onGone` once the process `pid` no longer exists (checked every `everyMs`). Returns a
 * function that stops watching.
 */
export function watchParent(
  pid: number,
  onGone: () => void,
  options: { everyMs?: number; alive?: (pid: number) => boolean } = {}
): () => void {
  const alive =
    options.alive ??
    ((p: number): boolean => {
      try {
        process.kill(p, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    })
  const timer = setInterval(() => {
    if (alive(pid)) return
    clearInterval(timer)
    onGone()
  }, options.everyMs ?? 2000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** The lines a server prints once the AI agents' server answers (or failed to bind). */
export function serverEndpointLines(status: AgentServerStatus): string[] {
  if (status.error) return [`AI agents: the server could not start: ${status.error}`]
  if (!status.running || !status.url) return ['AI agents: the server is not running']
  return [
    `AI agents: ${status.url}`,
    `  token:   ${status.token}  (send as "Authorization: Bearer <token>"; without it a new agent waits for an approval nobody can give)`,
    `  on this machine: zenium --mcp  (stdio, presents the token itself)`
  ]
}

/** The lines for a sign-in under way, approved or failed, from the sync status. */
export function signInLines(status: SyncStatus): string[] {
  if (status.account && !status.accountLink)
    return [`Zenium account: signed in as ${status.account.email}`]
  if (status.accountLink) {
    return [
      `Zenium account: open ${status.accountLink.verificationUrl} on any device and approve code ${status.accountLink.userCode}`
    ]
  }
  if (status.accountLinkFailure)
    return [`Zenium account: sign-in failed (${status.accountLinkFailure})`]
  if (!status.accountAvailable) return ['Zenium account: not available in this build']
  return []
}

/** The slice of the browser a server drives (kept narrow so the glue reads at a glance). */
export interface ServerBrowser {
  agentStatus(): AgentServerStatus
  enableAgents(): void
  syncStatus(): SyncStatus
  startSignIn(): Promise<void>
}

/**
 * Turn the AI agents on, print where they connect, and with `signIn` link the account,
 * printing each change of the sign-in until it is approved, fails or expires.
 */
export async function runServer(
  browser: ServerBrowser,
  options: { signIn: boolean; log?: (line: string) => void; pollMs?: number; waitMs?: number }
): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(`[zenium] ${line}`))
  const pollMs = options.pollMs ?? 500
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  browser.enableAgents()
  // The server binds asynchronously; a few seconds is plenty for a loopback listen.
  const until = Date.now() + (options.waitMs ?? 10_000)
  let agents = browser.agentStatus()
  while (!agents.running && !agents.error && Date.now() < until) {
    await sleep(pollMs)
    agents = browser.agentStatus()
  }
  for (const line of serverEndpointLines(agents)) log(line)

  if (!options.signIn) {
    for (const line of signInLines(browser.syncStatus())) log(line)
    return
  }
  if (browser.syncStatus().account) {
    for (const line of signInLines(browser.syncStatus())) log(line)
    return
  }
  await browser.startSignIn()
  let last = ''
  for (;;) {
    const status = browser.syncStatus()
    const lines = signInLines(status)
    const text = lines.join('\n')
    if (text !== last) {
      for (const line of lines) log(line)
      last = text
    }
    if (!status.accountLink) return
    await sleep(pollMs)
  }
}
