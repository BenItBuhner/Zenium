import type { JSX } from 'react'
import { useId, useState } from 'react'
import {
  AGENT_PROXY_MODES,
  PROXY_PROFILE_KINDS,
  PROXY_ROUTE_MATCHES,
  emptyAgentProxyGrant,
  emptyProxyProfile,
  emptyProxyRoute,
  profileProblem,
  routeProblem,
  type AgentProxyGrant,
  type AgentProxyMode,
  type AppProxySettings,
  type ProxyProfile,
  type ProxyProfileKind,
  type ProxyRoute,
  type ProxyRouteMatch
} from '@shared/appProxy'
import { Field, SheetActions, ValidationMessage } from './blocks'

const KIND_LABELS: Record<ProxyProfileKind, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5',
  pac: 'PAC script'
}

const MATCH_LABELS: Record<ProxyRouteMatch, string> = {
  host: 'Exact host',
  'host-suffix': 'Host and subdomains',
  wildcard: 'Host wildcard',
  scheme: 'Scheme',
  'url-prefix': 'URL prefix'
}

const MODE_LABELS: Record<AgentProxyMode, string> = {
  follow: 'Follow the tab',
  allow: 'Only listed proxies',
  direct: 'Direct connection only'
}

export function ProxyProfileForm({
  initial,
  onSubmit,
  close
}: {
  initial?: ProxyProfile
  onSubmit: (profile: ProxyProfile) => void
  close: () => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<ProxyProfile>(initial ?? emptyProxyProfile())
  const [judged, setJudged] = useState(false)
  const problem = judged ? profileProblem(draft) : null
  const save = (): void => {
    const next = profileProblem(draft)
    if (next) {
      setJudged(true)
      return
    }
    onSubmit(draft)
    close()
  }
  const set = (patch: Partial<ProxyProfile>): void => setDraft((current) => ({ ...current, ...patch }))
  const pac = draft.kind === 'pac'
  return (
    <div className="zen-settings-form" data-testid="proxy-profile-form">
      <Field id={`${id}-name`} label="Name">
        <input
          id={`${id}-name`}
          className="zen-settings-input zen-v2-field"
          value={draft.name}
          placeholder="Office"
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field id={`${id}-kind`} label="Type">
        <select
          id={`${id}-kind`}
          className="zen-settings-input zen-v2-field"
          value={draft.kind}
          onChange={(e) => set({ kind: e.target.value as ProxyProfileKind })}
        >
          {PROXY_PROFILE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>
      {pac ? (
        <>
          <Field id={`${id}-pac-url`} label="PAC URL" description="Leave empty to paste a script instead.">
            <input
              id={`${id}-pac-url`}
              className="zen-settings-input zen-v2-field"
              inputMode="url"
              value={draft.pacUrl}
              placeholder="https://example.com/proxy.pac"
              onChange={(e) => set({ pacUrl: e.target.value })}
            />
          </Field>
          <Field id={`${id}-pac-data`} label="PAC script">
            <textarea
              id={`${id}-pac-data`}
              className="zen-settings-input zen-v2-field"
              rows={6}
              value={draft.pacData}
              onChange={(e) => set({ pacData: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field id={`${id}-host`} label="Host">
            <input
              id={`${id}-host`}
              className="zen-settings-input zen-v2-field"
              value={draft.host}
              placeholder="proxy.example.com"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => set({ host: e.target.value })}
            />
          </Field>
          <Field id={`${id}-port`} label="Port">
            <input
              id={`${id}-port`}
              className="zen-settings-input zen-v2-field"
              inputMode="numeric"
              value={String(draft.port || '')}
              onChange={(e) => set({ port: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field id={`${id}-user`} label="Username" description="Optional.">
            <input
              id={`${id}-user`}
              className="zen-settings-input zen-v2-field"
              value={draft.username}
              autoComplete="off"
              onChange={(e) => set({ username: e.target.value })}
            />
          </Field>
          <Field id={`${id}-pass`} label="Password">
            <input
              id={`${id}-pass`}
              className="zen-settings-input zen-v2-field"
              type="password"
              value={draft.password}
              autoComplete="new-password"
              onChange={(e) => set({ password: e.target.value })}
            />
          </Field>
          <Field
            id={`${id}-bypass`}
            label="Bypass list"
            description="Comma-separated hosts that skip this proxy."
          >
            <input
              id={`${id}-bypass`}
              className="zen-settings-input zen-v2-field"
              value={draft.bypassList.join(', ')}
              placeholder="localhost, *.intranet.test"
              onChange={(e) =>
                set({
                  bypassList: e.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter((part) => part !== '')
                })
              }
            />
          </Field>
        </>
      )}
      {problem && <ValidationMessage message={problem} />}
      <SheetActions action={initial ? 'Save' : 'Add'} disabled={false} onCancel={close} onAction={save} />
    </div>
  )
}

export function ProxyRouteForm({
  settings,
  initial,
  onSubmit,
  close
}: {
  settings: AppProxySettings
  initial?: ProxyRoute
  onSubmit: (route: ProxyRoute) => void
  close: () => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<ProxyRoute>(initial ?? emptyProxyRoute())
  const [judged, setJudged] = useState(false)
  const problem = judged ? routeProblem(draft) : null
  const save = (): void => {
    if (routeProblem(draft)) {
      setJudged(true)
      return
    }
    onSubmit(draft)
    close()
  }
  const set = (patch: Partial<ProxyRoute>): void => setDraft((current) => ({ ...current, ...patch }))
  return (
    <div className="zen-settings-form" data-testid="proxy-route-form">
      <Field id={`${id}-match`} label="Match">
        <select
          id={`${id}-match`}
          className="zen-settings-input zen-v2-field"
          value={draft.match}
          onChange={(e) => set({ match: e.target.value as ProxyRouteMatch })}
        >
          {PROXY_ROUTE_MATCHES.map((match) => (
            <option key={match} value={match}>
              {MATCH_LABELS[match]}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${id}-pattern`} label="Pattern">
        <input
          id={`${id}-pattern`}
          className="zen-settings-input zen-v2-field"
          value={draft.pattern}
          placeholder={
            draft.match === 'url-prefix'
              ? 'https://intranet/'
              : draft.match === 'scheme'
                ? 'https'
                : 'corp.example'
          }
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => set({ pattern: e.target.value })}
        />
      </Field>
      <Field id={`${id}-target`} label="Use">
        <select
          id={`${id}-target`}
          className="zen-settings-input zen-v2-field"
          value={draft.target}
          onChange={(e) => set({ target: e.target.value })}
        >
          <option value="direct">Direct connection</option>
          <option value="system">System proxy</option>
          {settings.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name.trim() || profile.host || profile.id}
            </option>
          ))}
        </select>
      </Field>
      {problem && <ValidationMessage message={problem} />}
      <SheetActions action={initial ? 'Save' : 'Add'} onCancel={close} onAction={save} />
    </div>
  )
}

export function AgentProxyGrantForm({
  settings,
  initial,
  onSubmit,
  close
}: {
  settings: AppProxySettings
  initial?: AgentProxyGrant
  onSubmit: (grant: AgentProxyGrant) => void
  close: () => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<AgentProxyGrant>(initial ?? emptyAgentProxyGrant())
  const save = (): void => {
    if (draft.agentName.trim() === '') return
    onSubmit({ ...draft, agentName: draft.agentName.trim() })
    close()
  }
  return (
    <div className="zen-settings-form" data-testid="proxy-grant-form">
      <Field
        id={`${id}-name`}
        label="Agent name"
        description="The MCP client name. Use * for every agent that has no rule of its own."
      >
        <input
          id={`${id}-name`}
          className="zen-settings-input zen-v2-field"
          value={draft.agentName}
          placeholder="Claude"
          onChange={(e) => setDraft({ ...draft, agentName: e.target.value })}
        />
      </Field>
      <Field id={`${id}-mode`} label="Access">
        <select
          id={`${id}-mode`}
          className="zen-settings-input zen-v2-field"
          value={draft.mode}
          onChange={(e) => setDraft({ ...draft, mode: e.target.value as AgentProxyMode })}
        >
          {AGENT_PROXY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </Field>
      {draft.mode === 'allow' && (
        <fieldset className="zen-settings-field-block">
          <legend className="zen-settings-label">Allowed proxies</legend>
          {settings.profiles.length === 0 ? (
            <span className="zen-settings-description">Add a proxy first.</span>
          ) : (
            settings.profiles.map((profile) => {
              const checked = draft.proxyIds.includes(profile.id)
              return (
                <label key={profile.id} className="zen-settings-label">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        proxyIds: checked
                          ? draft.proxyIds.filter((id) => id !== profile.id)
                          : [...draft.proxyIds, profile.id]
                      })
                    }
                  />{' '}
                  {profile.name.trim() || profile.host || profile.id}
                </label>
              )
            })
          )}
        </fieldset>
      )}
      <SheetActions
        action={initial ? 'Save' : 'Add'}
        disabled={draft.agentName.trim() === ''}
        onCancel={close}
        onAction={save}
      />
    </div>
  )
}
