// The fixtures are the bundled snapshot's lists (gzipped): node's zlib reads them here alone.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { countNetworkFilters, parseListHeader, prepareListText } from '../../blocking/lists'
import { parseFeed } from '../../safebrowsing/feeds'
import { PrefixTable, prefixOf } from '../../safebrowsing/prefixes'
import {
  CORE_BACKGROUND_TASKS,
  PREPARE_LIST_TASK,
  SAFE_BROWSING_TABLE_TASK,
  type BackgroundReply,
  type BackgroundTask,
  type SafeBrowsingTableOutput
} from '../tasks'
import { serveBackgroundTasks } from '../worker'

const LIST_DIR = new URL('../../../../resources/blocking/', import.meta.url)

function readGz(name: string): string {
  return gunzipSync(readFileSync(new URL(`${name}.txt.gz`, LIST_DIR))).toString('utf8')
}

/** The hosts of the bundled urlhaus list (`||host^` filters), the realistic input of a feed. */
function urlhausHosts(limit: number): string[] {
  const out: string[] = []
  const re = /^\|\|([a-z0-9][a-z0-9.-]*)\^$/
  for (const line of readGz('urlhaus').split('\n')) {
    const m = re.exec(line)
    if (m) out.push(m[1])
    if (out.length >= limit) break
  }
  return out
}

/**
 * A feed's text in the `hosts` format the way the feeds serve it: a comment block, the hosts
 * with the sinkhole address, a duplicate, mixed case, a trailing dot, a line of noise.
 */
function hostsFeed(hosts: string[]): string {
  const lines = ['# Title: a feed', '# Last modified: today', '']
  hosts.forEach((host, i) => {
    lines.push(i % 3 === 0 ? `0.0.0.0 ${host.toUpperCase()}` : `0.0.0.0 ${host}`)
    if (i % 97 === 0) lines.push(`127.0.0.1 ${host}.`)
  })
  lines.push('not a host line', '0.0.0.0', '# the end')
  return lines.join('\n')
}

/**
 * Run `task` the way the worker does – its request and reply through `structuredClone`, the
 * output buffers moved – and hand back what the main thread would see.
 */
async function throughWorker<I, O>(task: BackgroundTask<I, O>, input: I): Promise<O> {
  return new Promise<O>((resolve, reject) => {
    let deliver: ((message: unknown) => void) | null = null
    serveBackgroundTasks(
      {
        postMessage: (message, transfer) => {
          const reply = structuredClone(message, { transfer }) as BackgroundReply
          if (reply.ok) resolve(reply.output as O)
          else reject(new Error(reply.error))
        },
        onMessage: (listener) => {
          deliver = listener
        }
      },
      [task as BackgroundTask<unknown, unknown>]
    )
    deliver?.(structuredClone({ id: 1, name: task.name, input }))
  })
}

describe('SAFE_BROWSING_TABLE_TASK', () => {
  const hosts = urlhausHosts(6000)
  const text = hostsFeed(hosts)

  it('builds the same table in the worker and on the main thread, byte for byte', async () => {
    const worker = await throughWorker(SAFE_BROWSING_TABLE_TASK, { text, format: 'hosts' })
    const inline = await SAFE_BROWSING_TABLE_TASK.runInline!({ text, format: 'hosts' })
    const reference = PrefixTable.fromHosts(parseFeed(text, 'hosts'))
    expect(worker.hosts).toBe(hosts.length)
    expect(worker.entries).toBe(reference.size)
    expect(inline.hosts).toBe(worker.hosts)
    expect(inline.entries).toBe(worker.entries)
    // The table's own bytes, and the document's base64 of them.
    const workerBytes = PrefixTable.fromSortedValues(worker.values).toBytes()
    const inlineBytes = PrefixTable.fromSortedValues(inline.values).toBytes()
    expect(Buffer.from(workerBytes).equals(Buffer.from(reference.toBytes()))).toBe(true)
    expect(Buffer.from(inlineBytes).equals(Buffer.from(reference.toBytes()))).toBe(true)
    expect(worker.base64).toBe(reference.toBase64())
    expect(inline.base64).toBe(reference.toBase64())
    // What crossed the boundary is a typed array again, adopted without a sort.
    expect(worker.values).toBeInstanceOf(BigUint64Array)
    const table = PrefixTable.fromSortedValues(worker.values)
    expect(table.size).toBe(reference.size)
    for (const host of hosts.slice(0, 50)) expect(table.has(prefixOf(host))).toBe(true)
    expect(table.has(prefixOf('not-listed.example'))).toBe(false)
  })

  it('moves the table out of the worker instead of copying it', () => {
    const output = SAFE_BROWSING_TABLE_TASK.run({ text, format: 'hosts' })
    const transfer = SAFE_BROWSING_TABLE_TASK.transferables!(output)
    expect(transfer).toEqual([output.values.buffer])
    const cloned = structuredClone(output, { transfer }) as SafeBrowsingTableOutput
    expect(output.values.byteLength).toBe(0)
    expect(cloned.values.length).toBe(cloned.entries)
  })

  it('reports a text without hosts as zero, in both paths', async () => {
    const empty = { text: '# nothing here\n\nnot a host\n', format: 'hosts' as const }
    expect(SAFE_BROWSING_TABLE_TASK.run(empty)).toMatchObject({ hosts: 0, entries: 0, base64: '' })
    expect(await SAFE_BROWSING_TABLE_TASK.runInline!(empty)).toMatchObject({ hosts: 0, entries: 0 })
  })

  it('reads the abp and domains formats too', async () => {
    const abp = ['! comment', '||evil.example^', '||EVIL.example^$all', 'not||a^host'].join('\n')
    const fromAbp = await throughWorker(SAFE_BROWSING_TABLE_TASK, { text: abp, format: 'abp' })
    expect(fromAbp.hosts).toBe(1)
    expect(fromAbp.entries).toBe(1)
    const domains = ['# comment', 'one.example', 'two.example', 'two.example.'].join('\n')
    const fromDomains = SAFE_BROWSING_TABLE_TASK.run({ text: domains, format: 'domains' })
    expect(fromDomains.hosts).toBe(2)
    expect(PrefixTable.fromSortedValues(fromDomains.values).has(prefixOf('two.example'))).toBe(true)
  })
})

describe('PREPARE_LIST_TASK', () => {
  const header = [
    '[Adblock Plus 2.0]',
    '! Title: EasyList (test copy)',
    '! Version: 202609220001',
    '! Homepage: https://easylist.to/',
    '! Licence: https://easylist.to/pages/licence.html',
    '! Expires: 4 days',
    ''
  ].join('\n')
  const cosmetic = ['example.com##.ad', 'example.net#@#.ok', '0.0.0.0 sink.example', 'bare.example']
  const text = header + readGz('ubo-badware') + '\n' + cosmetic.join('\n') + '\n'

  it('reduces a list to what prepareListText and parseListHeader give, in the worker', async () => {
    const worker = await throughWorker(PREPARE_LIST_TASK, { text })
    const prepared = prepareListText(text)
    expect(worker.text).toBe(prepared.text)
    expect(worker.count).toBe(prepared.count)
    expect(worker.count).toBe(countNetworkFilters(worker.text))
    expect(worker.header).toEqual(parseListHeader(text))
    expect(worker.header).toMatchObject({
      title: 'EasyList (test copy)',
      version: '202609220001',
      homepage: 'https://easylist.to/'
    })
    // The hosts-format and bare-host lines became `||host^` filters; the cosmetic ones went.
    expect(worker.text).toContain('||sink.example^')
    expect(worker.text).toContain('||bare.example^')
    expect(worker.text).not.toContain('##')
    expect(worker.text).not.toContain('#@#')
  })

  it('has no separate inline path: the same function runs on the main thread', () => {
    expect(PREPARE_LIST_TASK.runInline).toBeUndefined()
    expect(PREPARE_LIST_TASK.run({ text: '! only a comment\n' })).toMatchObject({ count: 0, text: '' })
  })
})

describe('the worker runtime', () => {
  it('serves every core task by name and refuses an unknown one', async () => {
    const names = CORE_BACKGROUND_TASKS.map((task) => task.name)
    expect(names).toEqual(['safebrowsing.table', 'blocking.prepareList'])
    expect(new Set(names).size).toBe(names.length)
    const replies: BackgroundReply[] = []
    let deliver: ((message: unknown) => void) | null = null
    serveBackgroundTasks(
      {
        postMessage: (message) => void replies.push(message),
        onMessage: (listener) => {
          deliver = listener
        }
      },
      CORE_BACKGROUND_TASKS
    )
    deliver!({ id: 7, name: 'nothing.here', input: null })
    deliver!({ id: 8, name: 'blocking.prepareList', input: { text: '||a.example^\n' } })
    deliver!('not a request')
    deliver!({ id: 9, name: 'blocking.prepareList', input: null })
    expect(replies[0]).toEqual({ id: 7, ok: false, error: 'unknown task nothing.here' })
    expect(replies[1]).toMatchObject({ id: 8, ok: true, output: { count: 1 } })
    // A task that throws on its input is a failed reply for that request alone.
    expect(replies[2]).toMatchObject({ id: 9, ok: false })
    expect(replies).toHaveLength(3)
  })
})
