import type { FormEvent, JSX } from 'react'
import { useState } from 'react'
import { parseInternalPageUrl } from '@shared/internalPages'
import type { AssistantStatus, AssistantTaskInfo, Tab, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { PageColumn, PageEmpty, PageGroup, PageTitleBlock } from '../PageFrame'

const EMPTY: AssistantStatus = { available: false, hasKey: false, memory: [], tasks: [] }

/**
 * Ask Zenium (`zen://ask?task=<id>`, `core/assistant`): one task at a time – the question, the
 * answer, a field for the follow-up – with the earlier tasks under it, then what the agent
 * remembers and the API key. The address bar's "Ask Zenium" row lands here with `task` set.
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
          description="An agent that works in tabs of its own, with your search engine, on your Anthropic API key. It asks before it sends, buys, posts or deletes anything."
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
      {!status.hasKey ? (
        <KeyForm available={status.available} />
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
          <PageGroup heading="API key" headingId="zen-ask-key">
            <div className="zen-ask-row">
              <span>Saved on this device</span>
              <button
                type="button"
                className="zen-v2-button"
                onClick={() => run('assistant.setKey', { key: '' })}
              >
                Remove
              </button>
            </div>
          </PageGroup>
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

function KeyForm({ available }: { available: boolean }): JSX.Element {
  const [key, setKey] = useState('')
  if (!available) return <PageEmpty>This device cannot store an API key</PageEmpty>
  return (
    <form
      className="zen-ask-composer"
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim()) run('assistant.setKey', { key })
      }}
    >
      <input
        className="zen-v2-field"
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Anthropic API key (sk-ant-…)"
        aria-label="Anthropic API key"
        autoComplete="off"
      />
      <button type="submit" className="zen-v2-button" data-primary="" disabled={!key.trim()}>
        Save key
      </button>
    </form>
  )
}
