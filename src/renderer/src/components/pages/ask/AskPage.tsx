import type { FormEvent, JSX } from 'react'
import { useState } from 'react'
import { parseInternalPageUrl } from '@shared/internalPages'
import type {
  AssistantProvider,
  AssistantStatus,
  AssistantTaskInfo,
  Tab,
  UIState
} from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { PageColumn, PageEmpty, PageGroup, PageTitleBlock } from '../PageFrame'

const EMPTY: AssistantStatus = {
  available: false,
  hasKey: false,
  provider: null,
  memory: [],
  tasks: []
}

/**
 * Ask Zenium (`zen://ask?task=<id>`, `core/assistant`): one task at a time – the question, the
 * answer, a field for the follow-up – with the earlier tasks under it, then what the agent
 * remembers and the model service it runs on. The address bar's "Ask Zenium" row lands here with `task` set.
 */
export function AskPage({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const status = state.assistant ?? EMPTY
  const urlTask = parseInternalPageUrl(tab.url)?.query?.task ?? null
  // The task picked on the page, until the address names another one.
  const [picked, setPicked] = useState({ from: urlTask, id: urlTask })
  const selected = picked.from === urlTask ? picked.id : urlTask
  const setSelected = (id: string | null): void => setPicked({ from: urlTask, id })
  const task = status.tasks.find((t) => t.id === selected) ?? null
  const others = status.tasks.filter((t) => t.id !== task?.id)

  return (
    <PageColumn
      testId="ask-page"
      className="zen-ask-page"
      header={
        <PageTitleBlock
          title="Ask Zenium"
          description="An agent that works in tabs of its own, with your search engine, on the model service you choose. It asks before it sends, buys, posts or deletes anything."
          actions={
            task && (
              <button type="button" className="zen-v2-button" onClick={() => setSelected(null)}>
                New question
              </button>
            )
          }
        />
      }
    >
      {!status.provider ? (
        <ServiceForm status={status} />
      ) : (
        <>
          {task ? <TaskView task={task} /> : <Composer onAsked={setSelected} />}
          {others.length > 0 && (
            <PageGroup heading="Earlier" headingId="zen-ask-earlier">
              <ul className="zen-page-rows" aria-labelledby="zen-ask-earlier">
                {others.map((t) => (
                  <li key={t.id} className="zen-v2-row zen-page-row">
                    <button
                      type="button"
                      className="zen-page-row-text"
                      onClick={() => setSelected(t.id)}
                    >
                      <span className="zen-page-row-label">{t.title}</span>
                      <span className="zen-page-row-desc">{statusLine(t)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </PageGroup>
          )}
          <Memory memory={status.memory} />
          <ServiceSummary status={status} />
        </>
      )}
    </PageColumn>
  )
}

function statusLine(t: AssistantTaskInfo): string {
  if (t.status === 'running') return 'Working…'
  if (t.status === 'failed') return t.error || 'Failed'
  if (t.status === 'stopped') return 'Stopped'
  return t.answer.split('\n')[0] || 'Done'
}

function Composer({
  taskId,
  onAsked,
  placeholder = 'Ask anything, or hand over a task'
}: {
  taskId?: string
  onAsked?: (id: string) => void
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState('')
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const prompt = text.trim()
    if (!prompt) return
    setText('')
    void cmd('assistant.ask', { prompt, taskId }).then((id) => onAsked?.(id))
  }
  return (
    <form className="zen-ask-composer" onSubmit={submit}>
      <input
        className="zen-v2-field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus
      />
      <button type="submit" className="zen-v2-button" data-primary="" disabled={!text.trim()}>
        Ask
      </button>
    </form>
  )
}

function TaskView({ task }: { task: AssistantTaskInfo }): JSX.Element {
  return (
    <section className="zen-ask-task" aria-live="polite" data-status={task.status}>
      {task.conversation.map((m, i) => (
        <div key={i} className="zen-ask-turn" data-role={m.role}>
          {m.text}
        </div>
      ))}
      {task.status === 'running' && (
        <div className="zen-ask-row">
          <span className="zen-ask-muted">Working in its own tabs…</span>
          <button
            type="button"
            className="zen-v2-button"
            onClick={() => run('assistant.stop', { taskId: task.id })}
          >
            Stop
          </button>
        </div>
      )}
      {task.status === 'failed' && <p className="zen-ask-error">{task.error}</p>}
      {task.status === 'stopped' && <p className="zen-ask-muted">Stopped.</p>}
      {task.status !== 'running' && <Composer taskId={task.id} placeholder="Follow up" />}
    </section>
  )
}

function Memory({ memory }: { memory: string[] }): JSX.Element {
  return (
    <PageGroup
      heading="What it remembers"
      headingId="zen-ask-memory"
      aside={memory.length ? `${memory.length} of 50` : undefined}
    >
      {memory.length === 0 ? (
        <PageEmpty>Nothing yet. It asks before it keeps anything</PageEmpty>
      ) : (
        <ul className="zen-page-rows" aria-labelledby="zen-ask-memory">
          {memory.map((fact, index) => (
            <li key={`${index}:${fact}`} className="zen-v2-row zen-page-row zen-ask-row">
              <span className="zen-page-row-label">{fact}</span>
              <button
                type="button"
                className="zen-v2-button"
                data-variant="quiet"
                onClick={() => run('assistant.forgetFact', { index })}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </PageGroup>
  )
}

const KINDS: { id: AssistantProvider['kind']; label: string; baseUrl: string }[] = [
  {
    id: 'openai',
    label: 'OpenAI-compatible (Responses API)',
    baseUrl: 'https://api.openai.com/v1'
  },
  {
    id: 'anthropic',
    label: 'Anthropic-compatible (Messages API)',
    baseUrl: 'https://api.anthropic.com'
  }
]

/** The service in use, with Change (the form again, filled in) and Remove. */
function ServiceSummary({ status }: { status: AssistantStatus }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const p = status.provider
  if (!p) return <></>
  return (
    <PageGroup heading="Model service" headingId="zen-ask-service">
      {editing ? (
        <ServiceForm status={status} onDone={() => setEditing(false)} />
      ) : (
        <div className="zen-ask-row">
          <span>
            {p.model} at {p.baseUrl}
            {status.hasKey ? '' : ' (no key)'}
          </span>
          <span className="zen-ask-actions">
            <button type="button" className="zen-v2-button" onClick={() => setEditing(true)}>
              Change
            </button>
            <button
              type="button"
              className="zen-v2-button"
              onClick={() => run('assistant.setProvider', { provider: null })}
            >
              Remove
            </button>
          </span>
        </div>
      )}
    </PageGroup>
  )
}

/**
 * Which API the service speaks, its address, the model and the key. The key field left empty
 * keeps the saved key when one is set (a local server may need none at all).
 */
function ServiceForm({
  status,
  onDone
}: {
  status: AssistantStatus
  onDone?: () => void
}): JSX.Element {
  const current = status.provider
  const [kind, setKind] = useState<AssistantProvider['kind']>(current?.kind ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? KINDS[0].baseUrl)
  const [model, setModel] = useState(current?.model ?? '')
  const [key, setKey] = useState('')
  if (!status.available) return <PageEmpty>This device cannot store an API key</PageEmpty>
  const pickKind = (next: AssistantProvider['kind']): void => {
    // The address follows the API while it is still another API's default.
    if (KINDS.some((k) => k.baseUrl === baseUrl) || !baseUrl.trim())
      setBaseUrl(KINDS.find((k) => k.id === next)!.baseUrl)
    setKind(next)
  }
  return (
    <form
      className="zen-ask-service"
      data-testid="ask-service-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!model.trim()) return
        void cmd('assistant.setProvider', {
          provider: { kind, baseUrl, model },
          ...(key.trim() || !status.hasKey ? { key } : {})
        }).then(() => onDone?.())
      }}
    >
      <p className="zen-ask-muted">
        Any service that speaks the OpenAI Responses API or the Anthropic Messages API: a hosted
        one, or a model running on your own machine.
      </p>
      <label>
        <span>API</span>
        <select
          className="zen-v2-field"
          value={kind}
          onChange={(e) => pickKind(e.target.value as AssistantProvider['kind'])}
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Address</span>
        <input
          className="zen-v2-field"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://…"
          autoComplete="off"
        />
      </label>
      <label>
        <span>Model</span>
        <input
          className="zen-v2-field"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="The model's name at that service"
          autoComplete="off"
        />
      </label>
      <label>
        <span>Key</span>
        <input
          className="zen-v2-field"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            status.hasKey ? 'Saved; type a new one to replace it' : 'Leave empty if none is needed'
          }
          autoComplete="off"
        />
      </label>
      <div className="zen-ask-actions">
        {onDone && (
          <button type="button" className="zen-v2-button" onClick={onDone}>
            Cancel
          </button>
        )}
        <button type="submit" className="zen-v2-button" data-primary="" disabled={!model.trim()}>
          Save
        </button>
      </div>
    </form>
  )
}
