// The `mcp` scenario: the MCP server (Settings → AI Agents) soaked on the unpacked build, short –
// scripts/mcp-soak.mjs's legs run in-process against the harness's launch, their verdict judged
// per step. Its own file so the harness's scenario table gains one line for it.
//
// A profile past onboarding with the server on (`settings.agents`: enabled, a free port, LAN off,
// new agents approved without asking, scripts allowed – the soak's clients carry the token, which
// approves them anyway) is launched twice, `mcp` and `mcp-restart`, the second being the restart
// the first prepares for:
//
//   mcp
//     server-up             <profile>/zen/agent.json says running and the URL answers (fatal)
//     soak                  MCP_SOAK.sessions agent lives, MCP_SOAK.concurrency at a time, one round
//                           (soakMainLeg: initialize, status, background mode, a tab on the soak's
//                           own fixture page, snapshot, screenshot, the form, foreground mode,
//                           screenshot, `zen_session end` – closeTabs on the even ones – a call
//                           after it on the same id, the adoption of an earlier orphan, end, DELETE)
//     shim                  MCP_SOAK.shimSessions of the same through `zenium --mcp`, one process
//                           each (the build's own executable, the leg's --extra-args)
//     drop                  a client quiet without DELETE; another lists its group as owned, adopts
//                           it with force: true (soft until E), and after the DELETE for real
//     resurrection          a made-up session id with the token is 200 + "resumed"; without, 404
//     carry-across-restart  an HTTP session and a shim process that the restart must not lose
//     quit                  the graceful quit (the profile's server stops with it)
//   mcp-restart
//     server-up             the same profile's server back (the same token: agent.json keeps it)
//     old-session-resumes   the HTTP session id from before the quit is answered with the
//                           "resumed" notice; the shim process from before answers a call too
//     diagnostics           what the soak left is adopted and closed; `zenium://diagnostics` read
//                           into the verdict
//     quit
//
// A step FAILS on a hard check that failed during it (the checks scripts/mcp-soak.mjs names:
// a tool error, a session lost, no resurrection, a DELETE not 204 …); the soft checks – the
// ones named with the PR they wait on, `background-screenshot (until B)` and their kin – are
// counted in the step's detail and never fail it, so CI stays green until those PRs land. The
// whole verdict (counts, client latency per tool and leg, the server's diagnostics) is written
// to <out>/<label>/soak.json next to result.json and printed as the soak's table into the log.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  Latencies,
  Verdict,
  formatTable,
  readDiagnostics,
  restartCarry,
  restartVerify,
  resurrectionProbes,
  soakDropLeg,
  soakMainLeg,
  soakShimLeg,
  startFixture,
  summarizeDiagnostics,
  tidy,
  waitForEndpoint
} from '../../scripts/mcp-soak.mjs'

export const MCP_SCENARIO = 'mcp'
export const MCP_RESTART_SCENARIO = 'mcp-restart'

/** The soak's size on CI: short – a runner's minute, not the full 3 × 30. */
export const MCP_SOAK = Object.freeze({ sessions: 6, concurrency: 3, rounds: 1, shimSessions: 2 })

/** How long the server may take to answer after a launch. */
const SERVER_UP_MS = 60_000

/**
 * Settings → AI Agents as the profile is seeded: the server on at `port`, loopback only, new
 * agents let in without the approval prompt, page scripts allowed (the soak's clients hold the
 * token, which approves them either way), the cursor shown as by default.
 */
export function agentSettings(port) {
  return {
    enabled: true,
    port,
    lan: false,
    approveNewAgents: false,
    approvedNames: [],
    defaultMode: 'foreground',
    allowScripts: true,
    showCursor: true
  }
}

/** A port nothing listens on right now (the OS's pick, released again). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Where a step starts: the verdict's counts and every check's failure count so far. */
export function mark(verdict) {
  const checks = {}
  for (const [name, c] of Object.entries(verdict.summary().checks)) checks[name] = c.fail
  return { counts: verdict.snapshot(), checks }
}

/**
 * A step's outcome from the checks added since `before`: the sessions and calls it made, the
 * hard and soft failures, which checks failed (with the check's first quoted detail) – and
 * `error`, the message the step fails with, when a hard check failed; null otherwise.
 */
export function judgeStep(verdict, before) {
  const since = verdict.since(before.counts)
  const failed = { hard: [], soft: [] }
  for (const [name, c] of Object.entries(verdict.summary().checks)) {
    const failures = c.fail - (before.checks[name] ?? 0)
    if (failures > 0) failed[c.kind].push({ name, failures, sample: c.samples[0] ?? null })
  }
  const detail = {
    sessions: since.sessions,
    calls: since.calls,
    hardFailures: since.hard,
    softFailures: since.soft,
    failed
  }
  const error =
    since.hard > 0
      ? `${since.hard} hard check(s) failed: ${failed.hard
          .map((f) => `${f.name} ×${f.failures}${f.sample ? ` (${f.sample})` : ''}`)
          .join('; ')}`
      : null
  return { detail, error }
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `log`,
 * the executable under test (`exe`; the shim processes are its `--mcp`), the leg's extra
 * arguments (`extraArgs`, passed on to those processes) and the label's output directory
 * (`outDir`, where soak.json goes).
 */
export async function scenarioMcp(h) {
  const { freshProfile, runScenario, log, exe, extraArgs, outDir } = h
  const port = await freePort()
  const userData = freshProfile(`profile-${MCP_SCENARIO}`, {
    onboardingDone: true,
    settings: { agents: agentSettings(port) }
  })
  const fixture = await startFixture()
  const verdict = new Verdict()
  const latencies = new Latencies()
  const ctx = {
    endpoint: null,
    fixture,
    verdict,
    latencies,
    log: (line) => log(`mcp: ${verdict.redact(line)}`),
    verbose: () => undefined,
    extraArgs
  }
  const legs = []
  let carry = { sessionId: null, shim: null }
  let diagnostics = null

  /** A step whose pass or fail is the soak's hard checks during it; the soft ones its detail. */
  const judged = (s, name, fn, opts) =>
    s.step(
      name,
      async () => {
        const before = mark(verdict)
        const extra = (await fn()) ?? {}
        const { detail, error } = judgeStep(verdict, before)
        if (error) {
          const e = new Error(error)
          e.detail = { ...detail, ...extra }
          throw e
        }
        return { ...detail, ...extra }
      },
      opts
    )
  const serverUp = (s) =>
    s.step(
      'server-up',
      async () => {
        ctx.endpoint = await waitForEndpoint(userData, SERVER_UP_MS)
        if (!verdict.secrets.includes(ctx.endpoint.token)) verdict.secrets.push(ctx.endpoint.token)
        return { url: ctx.endpoint.url, port }
      },
      { fatal: true }
    )
  const summary = () =>
    verdict.summary({
      options: { ...MCP_SOAK, legs, fixture: 'built-in', strict: false },
      latency: latencies.summary(),
      diagnostics
    })

  try {
    const first = await runScenario(MCP_SCENARIO, userData, {}, async (s, out) => {
      out.port = port
      await serverUp(s)
      legs.push('http')
      await judged(s, 'soak', () => soakMainLeg(ctx, MCP_SOAK), { timeoutMs: 300_000 })
      legs.push('stdio')
      await judged(
        s,
        'shim',
        () =>
          soakShimLeg(ctx, {
            exe,
            userDataDir: userData,
            sessions: MCP_SOAK.shimSessions,
            concurrency: 2
          }),
        { timeoutMs: 180_000 }
      )
      legs.push('drop')
      await judged(s, 'drop', () => soakDropLeg(ctx), { timeoutMs: 120_000 })
      await judged(s, 'resurrection', () => resurrectionProbes(ctx))
      legs.push('restart')
      await judged(s, 'carry-across-restart', async () => {
        carry = await restartCarry(ctx, { exe, userDataDir: userData })
        return { httpSession: Boolean(carry.sessionId), shimProcess: Boolean(carry.shim) }
      })
      await s.step('quit', () => s.quitGracefully())
    })
    if (first.fatal) return first

    return await runScenario(MCP_RESTART_SCENARIO, userData, {}, async (s, out) => {
      out.port = port
      await serverUp(s)
      await judged(s, 'old-session-resumes', () => restartVerify(ctx, carry), {
        timeoutMs: 120_000
      })
      carry = { sessionId: null, shim: null }
      await judged(s, 'diagnostics', async () => {
        await tidy(ctx)
        diagnostics = await readDiagnostics(ctx)
        return { server: summarizeDiagnostics(diagnostics) }
      })
      out.soak = summary().counts
      await s.step('quit', () => s.quitGracefully())
    })
  } finally {
    if (carry.shim) await carry.shim.close().catch(() => undefined)
    await fixture.close()
    const final = summary()
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'soak.json'), JSON.stringify(final, null, 2) + '\n')
    for (const line of formatTable(final).split('\n')) log(`mcp: ${line}`)
  }
}
