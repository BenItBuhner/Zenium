import type { JSX } from 'react'
import { useState } from 'react'
import { Bot, Check, Copy, KeyRound, Radio, Trash2, Wifi } from 'lucide-react'
import type { AgentInfo, Settings, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { cn, relativeTime } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Group, Note, Row, Segmented } from './SettingsPrimitives'

/**
 * Settings → AI Agents: turn the built-in MCP server on, see how to connect, and manage the
 * agents that are driving the browser right now.
 */
export function AgentsSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const a = state.settings.agents
  const server = state.agentServer
  const agents = state.agents
  const setAgents = (patch: Partial<Settings['agents']>): void =>
    set({ agents: { ...a, ...patch } })
  return (
    <>
      <section className="px-2.5">
        <h3 className="zen-settings-heading px-0">AI agents</h3>
        <p className="zen-settings-hint">
          Let any AI agent drive this browser through a built-in{' '}
          <span className="font-medium">Model Context Protocol</span> server — no extension or
          plugin to install. Agents open their own tabs, read pages and click and type in them; each
          one gets a coloured cursor and tab badge, and several can share the browser at once. The
          server listens on your computer only ({' '}
          <code className="rounded bg-[var(--zen-element-bg)] px-1">127.0.0.1</code> ) unless you
          turn on local-network access.
        </p>
      </section>

      <Group title="Server">
        <Row
          label="Enable the MCP server"
          hint={server.error ?? serverHint(server.running, server.url)}
        >
          <Switch checked={a.enabled} onCheckedChange={(v) => setAgents({ enabled: v })} />
        </Row>
        <Row label="Port" hint="The loopback endpoint agents connect to.">
          <Input
            type="number"
            className="w-28"
            value={String(a.port)}
            min={1024}
            max={65535}
            onChange={(e) => {
              const port = Number(e.target.value)
              if (Number.isInteger(port) && port >= 1024 && port <= 65535) setAgents({ port })
            }}
          />
        </Row>
        <Row
          label="Allow devices on the local network"
          hint="Off by default. Lets an agent on another device (e.g. your laptop) drive this browser over Wi-Fi."
        >
          <Switch checked={a.lan} onCheckedChange={(v) => setAgents({ lan: v })} />
        </Row>
      </Group>

      {a.enabled && server.running && server.url && (
        <ConnectionCard url={server.url} lanUrls={server.lanUrls} token={server.token} />
      )}

      <Group title="Behaviour">
        <Row
          label="Default mode for new agents"
          hint="Foreground brings the agent's tab in front of you before each action; background keeps you on your own tab."
        >
          <Segmented
            label="Default mode for new agents"
            value={a.defaultMode}
            onChange={(v) => setAgents({ defaultMode: v })}
            options={[
              { value: 'foreground', label: 'Foreground' },
              { value: 'background', label: 'Background' }
            ]}
          />
        </Row>
        <Row
          label="Show the agent's cursor"
          hint="Draw a labelled cursor in the pages an agent drives."
        >
          <Switch checked={a.showCursor} onCheckedChange={(v) => setAgents({ showCursor: v })} />
        </Row>
        <Row
          label="Ask before a new agent connects"
          hint="When off, any agent that reaches the server may control the browser. The connection token always skips the prompt."
        >
          <Switch
            checked={a.approveNewAgents}
            onCheckedChange={(v) => setAgents({ approveNewAgents: v })}
          />
        </Row>
        <Row
          label="Allow agents to run JavaScript in pages"
          hint="Enables the browser_evaluate tool. Powerful, but lets an agent run arbitrary script in the pages it drives."
        >
          <Switch
            checked={a.allowScripts}
            onCheckedChange={(v) => setAgents({ allowScripts: v })}
          />
        </Row>
      </Group>

      <Group title="Connected agents">
        {agents.length === 0 ? (
          <Note>
            {a.enabled
              ? 'No agents connected. Point an MCP client at the endpoint above.'
              : 'Turn the server on to let agents connect.'}
          </Note>
        ) : (
          agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)
        )}
      </Group>

      {a.approvedNames.length > 0 && (
        <Group title="Remembered agents">
          {a.approvedNames.map((name) => (
            <Row key={name} label={name} hint="Allowed to connect without asking.">
              <Button variant="ghost" size="sm" onClick={() => run('agent.forget', { name })}>
                <Trash2 className="h-3.5 w-3.5" /> Forget
              </Button>
            </Row>
          ))}
        </Group>
      )}
    </>
  )
}

function serverHint(running: boolean, url: string | null): string {
  if (running && url) return `Running at ${url}`
  return 'The server is off.'
}

function ConnectionCard({
  url,
  lanUrls,
  token
}: {
  url: string
  lanUrls: string[]
  token: string
}): JSX.Element {
  const httpConfig = JSON.stringify({ mcpServers: { zenium: { url } } }, null, 2)
  const stdioConfig = JSON.stringify(
    { mcpServers: { zenium: { command: 'zenium', args: ['--mcp'] } } },
    null,
    2
  )
  return (
    <section className="flex flex-col gap-3 px-2.5">
      <h3 className="zen-settings-heading flex items-center gap-2 px-0">
        <Radio className="h-4 w-4 text-[var(--zen-accent-ink)]" /> Connect an agent
      </h3>
      <CopyField label="Streamable HTTP endpoint" value={url} />
      <CopyField
        label="Connection token (skips the approval prompt)"
        value={token}
        secret
        icon={<KeyRound className="h-3.5 w-3.5" />}
      />
      {lanUrls.length > 0 && (
        <div className="zen-settings-hint flex items-start gap-2">
          <Wifi className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            On the local network: {lanUrls.join(', ')} — only share the token with devices you
            trust.
          </span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <CopyBlock label="mcp.json (URL)" value={httpConfig} />
        <CopyBlock label="mcp.json (command)" value={stdioConfig} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="zen-settings-hint">
          Put the token in an{' '}
          <code className="rounded bg-[var(--zen-element-bg)] px-1">Authorization: Bearer</code>{' '}
          header, or append{' '}
          <code className="rounded bg-[var(--zen-element-bg)] px-1">?token=…</code> to the URL.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void cmd('agent.regenerateToken', undefined)}
        >
          Regenerate token
        </Button>
      </div>
    </section>
  )
}

function AgentRow({ agent }: { agent: AgentInfo }): JSX.Element {
  return (
    <div className="zen-settings-row py-2">
      <div
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white"
        style={{ background: agent.color }}
      >
        <Bot className="h-4 w-4" />
      </div>
      <div className="zen-settings-text">
        <div className="zen-settings-label flex items-center gap-2 font-medium">
          <span className="truncate">{agent.name}</span>
          {agent.pending && (
            <span className="zen-settings-warn rounded-full px-2 py-0.5 text-[10px] font-semibold">
              Awaiting approval
            </span>
          )}
        </div>
        <div className="zen-settings-hint tabular-nums">
          {agent.transport === 'stdio' ? 'stdio' : 'HTTP'} · {agent.tabIds.length} tab
          {agent.tabIds.length === 1 ? '' : 's'} · {agent.calls} action
          {agent.calls === 1 ? '' : 's'} · active {relativeTime(agent.lastActiveAt)}
        </div>
      </div>
      <div className="zen-settings-control gap-1">
        <ModeToggle agent={agent} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run('agent.disconnect', { id: agent.id })}
          title="Disconnect this agent and release its tabs"
        >
          Disconnect
        </Button>
      </div>
    </div>
  )
}

function ModeToggle({ agent }: { agent: AgentInfo }): JSX.Element {
  const next = agent.mode === 'foreground' ? 'background' : 'foreground'
  return (
    <button
      type="button"
      className={cn(
        'rounded-full px-2.5 py-1 text-[11px] font-medium',
        agent.mode === 'foreground'
          ? 'bg-[rgb(var(--zen-accent-rgb)/0.16)] text-[var(--zen-fg)]'
          : 'bg-[var(--zen-element-bg)] text-[var(--zen-muted)]'
      )}
      title={`Switch to ${next} mode`}
      onClick={() => run('agent.setMode', { id: agent.id, mode: next })}
    >
      {agent.mode}
    </button>
  )
}

function CopyField({
  label,
  value,
  secret,
  icon
}: {
  label: string
  value: string
  secret?: boolean
  icon?: JSX.Element
}): JSX.Element {
  const [revealed, setRevealed] = useState(!secret)
  return (
    <div className="flex flex-col gap-1">
      <span className="zen-settings-hint">{label}</span>
      <div className="flex items-center gap-2">
        {icon}
        <code className="min-w-0 flex-1 truncate rounded-lg bg-[var(--zen-element-bg)] px-2.5 py-1.5 text-[12px]">
          {revealed ? value : '•'.repeat(Math.min(40, value.length))}
        </code>
        {secret && (
          <Button variant="ghost" size="sm" onClick={() => setRevealed((r) => !r)}>
            {revealed ? 'Hide' : 'Show'}
          </Button>
        )}
        <CopyButton value={value} />
      </div>
    </div>
  )
}

function CopyBlock({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="zen-settings-hint">{label}</span>
        <CopyButton value={value} />
      </div>
      <pre className="zen-squircle overflow-x-auto rounded-[10px] bg-[var(--zen-element-bg)] p-2.5 text-[11px] leading-relaxed">
        {value}
      </pre>
    </div>
  )
}

function CopyButton({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}
