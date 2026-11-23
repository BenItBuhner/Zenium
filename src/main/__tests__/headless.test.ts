import { describe, expect, it, vi } from 'vitest'
import {
  runServer,
  serverEndpointLines,
  serverRelaunchArgs,
  serverUnsupportedLine,
  signInLines,
  watchParent,
  type ServerBrowser
} from '../headless'
import { emptyAgentServerStatus } from '../../shared/defaults'
import type { AgentServerStatus, SyncStatus } from '../../shared/types'

const running: AgentServerStatus = {
  ...emptyAgentServerStatus(),
  running: true,
  url: 'http://127.0.0.1:41735/mcp',
  token: 'tok'
}

/** Only the fields the server reads; the rest of `SyncStatus` does not matter here. */
function sync(partial: Partial<SyncStatus>): SyncStatus {
  return {
    accountAvailable: true,
    account: null,
    accountLink: null,
    accountLinkFailure: null,
    ...partial
  } as SyncStatus
}

describe('serverRelaunchArgs', () => {
  it('starts a Linux server again on the headless Ozone platform at a laptop screen size', () => {
    expect(serverRelaunchArgs(['.', '--server'], 'linux', true)).toEqual([
      '.',
      '--server',
      '--ozone-platform=headless',
      '--ozone-override-screen-size=1920,1080'
    ])
  })

  it('leaves a launch alone that is not a server, not Linux, or chose its own platform', () => {
    expect(serverRelaunchArgs(['.'], 'linux', false)).toBeNull()
    expect(serverRelaunchArgs(['.', '--server'], 'win32', true)).toBeNull()
    expect(serverRelaunchArgs(['--server', '--ozone-platform=x11'], 'linux', true)).toBeNull()
    expect(serverRelaunchArgs(['--server', '--ozone-platform'], 'linux', true)).toBeNull()
  })

  it('says so where there is no headless mode yet', () => {
    expect(serverUnsupportedLine('linux')).toBeNull()
    expect(serverUnsupportedLine('darwin')).toContain('Linux only')
  })
})

describe('serverEndpointLines', () => {
  it('prints the endpoint, the token and the stdio command', () => {
    const lines = serverEndpointLines(running)
    expect(lines[0]).toBe('AI agents: http://127.0.0.1:41735/mcp')
    expect(lines[1]).toContain('tok')
    expect(lines[2]).toContain('zenium --mcp')
  })

  it('names a bind failure, and a server that is not up', () => {
    expect(serverEndpointLines({ ...running, running: false, error: 'port in use' })).toEqual([
      'AI agents: the server could not start: port in use'
    ])
    expect(serverEndpointLines(emptyAgentServerStatus())).toEqual([
      'AI agents: the server is not running'
    ])
  })
})

describe('signInLines', () => {
  it('shows the code to approve, the account once approved, and a failure', () => {
    const link = {
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://x/link?code=ABCD-EFGH',
      expiresAt: 0
    }
    expect(signInLines(sync({ accountLink: link }))[0]).toContain('approve code ABCD-EFGH')
    expect(signInLines(sync({ account: { email: 'a@b.c' } }))).toEqual([
      'Zenium account: signed in as a@b.c'
    ])
    expect(signInLines(sync({ accountLinkFailure: 'expired' }))).toEqual([
      'Zenium account: sign-in failed (expired)'
    ])
    expect(signInLines(sync({ accountAvailable: false }))[0]).toContain('not available')
    expect(signInLines(sync({}))).toEqual([])
  })
})

describe('runServer', () => {
  it('turns the agents on, waits for the server, and prints where to connect', async () => {
    let status = emptyAgentServerStatus()
    const browser: ServerBrowser = {
      agentStatus: () => status,
      enableAgents: vi.fn(() => {
        setTimeout(() => (status = running), 5)
      }),
      syncStatus: () => sync({}),
      startSignIn: vi.fn(async () => undefined)
    }
    const lines: string[] = []
    await runServer(browser, { signIn: false, log: (l) => lines.push(l), pollMs: 1 })
    expect(browser.enableAgents).toHaveBeenCalledOnce()
    expect(browser.startSignIn).not.toHaveBeenCalled()
    expect(lines[0]).toBe('AI agents: http://127.0.0.1:41735/mcp')
  })

  it('with signIn prints the code, then the account once it is approved', async () => {
    let state = sync({})
    const link = { userCode: 'WXYZ-1234', verificationUrl: 'https://x/link', expiresAt: 0 }
    const browser: ServerBrowser = {
      agentStatus: () => running,
      enableAgents: () => undefined,
      syncStatus: () => state,
      startSignIn: async () => {
        state = sync({ accountLink: link })
        setTimeout(() => (state = sync({ account: { email: 'me@example.com' } })), 5)
      }
    }
    const lines: string[] = []
    await runServer(browser, { signIn: true, log: (l) => lines.push(l), pollMs: 1 })
    expect(lines.slice(3)).toEqual([
      'Zenium account: open https://x/link on any device and approve code WXYZ-1234',
      'Zenium account: signed in as me@example.com'
    ])
  })

  it('does not sign in again a machine that is signed in', async () => {
    const browser: ServerBrowser = {
      agentStatus: () => running,
      enableAgents: () => undefined,
      syncStatus: () => sync({ account: { email: 'me@example.com' } }),
      startSignIn: vi.fn(async () => undefined)
    }
    const lines: string[] = []
    await runServer(browser, { signIn: true, log: (l) => lines.push(l), pollMs: 1 })
    expect(browser.startSignIn).not.toHaveBeenCalled()
    expect(lines.at(-1)).toBe('Zenium account: signed in as me@example.com')
  })
})

describe('watchParent', () => {
  it('calls back once when the process is gone, and stops watching', () => {
    vi.useFakeTimers()
    try {
      let alive = true
      const onGone = vi.fn()
      watchParent(42, onGone, { everyMs: 100, alive: () => alive })
      vi.advanceTimersByTime(300)
      expect(onGone).not.toHaveBeenCalled()
      alive = false
      vi.advanceTimersByTime(500)
      expect(onGone).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
