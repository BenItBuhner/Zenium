import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPromptKind, HttpAuthPrompt, PermissionPrompt } from '../../../shared/types'
import type { AgentSession } from '../service'
import { httpAuthSpec, permissionSpec } from '../nativePrompts'
import { FakePage } from './fakePage'
import { fakeBrowser, textOf, type FakeBrowser, type FakeBrowserOptions } from './fakeBrowser'

const DESKTOP: AgentPromptKind[] = [
  'file-chooser',
  'download',
  'http-auth',
  'client-certificate',
  'permission',
  'screen-capture',
  'device-chooser',
  'device-pairing',
  'external-protocol',
  'print'
]
const ANDROID: AgentPromptKind[] = ['http-auth', 'permission', 'external-protocol']

const live: FakeBrowser[] = []
afterEach(async () => {
  for (const f of live.splice(0)) await f.stop()
})

function browser(options: FakeBrowserOptions = { agentPrompts: DESKTOP }): FakeBrowser {
  const fake = fakeBrowser({}, options)
  live.push(fake)
  return fake
}

async function openTab(fake: FakeBrowser, s: AgentSession, url: string): Promise<string> {
  return fake.openedTab(await fake.call(s, 'browser_tabs', { action: 'new', url }))
}

const settle = <T>(p: Promise<T>, ms: number): Promise<T | 'HUNG'> =>
  Promise.race([p, new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms))])

const listed = (fake: FakeBrowser, s: AgentSession): string[] =>
  fake.service.listTools(s).map((t) => t.name)

function uploadPage(url: string): FakePage {
  return new FakePage([
    {
      id: 0,
      parentId: null,
      url,
      origin: new URL(url).origin,
      name: '',
      title: 'Upload',
      elements: [
        {
          id: 'file',
          tag: 'input',
          role: 'button',
          name: 'Attachment',
          box: { x: 20, y: 20, width: 200, height: 30 },
          file: { mode: 'multiple', accept: ['.pdf'] }
        },
        {
          id: 'country',
          tag: 'select',
          role: 'combobox',
          name: 'Country',
          box: { x: 20, y: 80, width: 200, height: 30 },
          popup: 'select'
        },
        {
          id: 'zone',
          tag: 'div',
          role: 'region',
          name: 'Drop files here',
          box: { x: 20, y: 140, width: 300, height: 100 }
        }
      ]
    }
  ])
}

const auth = (tabId: string): HttpAuthPrompt & { tabId: string } =>
  ({
    host: 'intra.test',
    port: 443,
    realm: 'Staff',
    scheme: 'basic',
    isProxy: false,
    secure: true,
    failedBefore: false,
    tabId
  }) as unknown as HttpAuthPrompt & { tabId: string }

const camera = (tabId: string): PermissionPrompt & { tabId: string } =>
  ({
    id: 'p1',
    tabId,
    origin: 'https://cam.test',
    permission: 'camera',
    message: 'cam.test wants to use your camera',
    detail: '',
    allowOnce: true
  }) as unknown as PermissionPrompt & { tabId: string }

describe('native prompts: what each host hands agents', () => {
  it('lists the prompt tools only where the host routes prompts, and says what it keeps', async () => {
    const desktop = browser()
    const d = await desktop.connect('desk')
    expect(listed(desktop, d)).toEqual(
      expect.arrayContaining(['browser_prompts', 'browser_respond_prompt', 'browser_file_upload'])
    )
    expect(desktop.service.instructions(d)).toContain('Never reach for OS automation')
    expect(desktop.service.instructions(d)).not.toContain('This browser does not hand you')

    const android = browser({ agentPrompts: ANDROID })
    const a = await android.connect('phone')
    expect(listed(android, a)).toContain('browser_respond_prompt')
    expect(listed(android, a)).not.toContain('browser_file_upload')
    expect(android.service.instructions(a)).toContain(
      'This browser does not hand you: file-chooser, download, client-certificate'
    )

    const none = browser({})
    const n = await none.connect('old')
    expect(listed(none, n)).not.toContain('browser_prompts')
    expect(none.service.instructions(n)).not.toContain('Native prompts on your tabs')
  })

  it("intercepts an agent's page while it works it, and lets go when the user takes it back", async () => {
    const fake = browser()
    const s = await fake.connect('worker')
    const tab = await openTab(fake, s, 'https://a.test')
    expect(fake.intercepts.get(tab)).toEqual([true])
    fake.service.releaseTab(tab)
    expect(fake.intercepts.get(tab)?.at(-1)).toBe(false)
  })
})

describe("native prompts on an agent's tab are the agent's", () => {
  it('a file chooser waits for the agent, shows in every result, and takes its files', async () => {
    const fake = browser()
    const s = await fake.connect('uploader')
    const tab = await openTab(fake, s, 'https://docs.test')
    const chosen = fake.service.onFileChooser(tab, {
      mode: 'multiple',
      accept: ['.pdf'],
      source: 'input'
    })
    const status = textOf(await fake.call(s, 'zen_status'))
    expect(status).toContain('Waiting for your answer (1 prompt')
    expect(status).toContain('The page opened a file chooser for files (it accepts .pdf).')
    const listedPrompts = JSON.parse(textOf(await fake.call(s, 'browser_prompts'))) as {
      prompts: Array<{ id: string; kind: string; defaultAction: string }>
    }
    expect(listedPrompts.prompts).toMatchObject([{ kind: 'file-chooser', defaultAction: 'cancel' }])
    const res = await fake.call(s, 'browser_file_upload', {
      tabId: tab,
      paths: ['/home/me/a.pdf', '/home/me/b.pdf']
    })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(textOf(res)).toContain("Handed the page's file chooser 2 files.")
    expect(await chosen).toEqual({
      kind: 'files',
      files: [{ path: '/home/me/a.pdf' }, { path: '/home/me/b.pdf' }]
    })
    expect(textOf(await fake.call(s, 'zen_status'))).not.toContain('Waiting for your answer')
  })

  it('takes no paths from an agent on another machine, only inline files', async () => {
    const fake = browser()
    const s = fake.service.create({
      transport: 'http',
      token: fake.service.serverStatus().token,
      remoteAddress: '192.168.1.20',
      userAgent: 'test'
    })
    await fake.service.onInitialize(s, { name: 'remote', version: '1.0' })
    const tab = await openTab(fake, s, 'https://docs.test')
    const chosen = fake.service.onFileChooser(tab, { mode: 'single', accept: [], source: 'input' })
    const refused = await fake.call(s, 'browser_file_upload', {
      tabId: tab,
      paths: ['/etc/passwd']
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('another machine')
    await fake.call(s, 'browser_file_upload', {
      tabId: tab,
      files: [{ name: 'a.txt', base64: 'aGk=' }]
    })
    expect(await chosen).toEqual({ kind: 'files', files: [{ name: 'a.txt', base64: 'aGk=' }] })
  })

  it("a user's own tab keeps the system's chooser and its print dialog", async () => {
    const fake = browser()
    await fake.connect('worker')
    const mine = fake.user.openTab('https://bank.test')
    expect(
      await fake.service.onFileChooser(mine.id, { mode: 'single', accept: [], source: 'input' })
    ).toEqual({ kind: 'user' })
    expect(fake.service.onPagePrompt(mine.id, { kind: 'print' })).toBe('user')
    expect(fake.service.routePrompt(permissionSpec(camera(mine.id)))).toBeNull()
    expect(fake.service.downloadDestination(mine.id, download())).toBeNull()
  })

  it('a sign-in the page waits on ends the running call; the answer goes to that request only', async () => {
    const fake = browser()
    const s = await fake.connect('intranet')
    const tab = await openTab(fake, s, 'https://intra.test')
    const gate = fake.hold(tab)
    const call = fake.call(s, 'browser_click', { tabId: tab, target: 'text=Go' })
    await new Promise((r) => setTimeout(r, 20))
    const handle = fake.service.routePrompt(httpAuthSpec(auth(tab)))
    expect(handle).not.toBeNull()
    const res = await settle(call, 500)
    expect(res).not.toBe('HUNG')
    expect(res !== 'HUNG' && textOf(res)).toContain('intra.test asks to sign in to "Staff".')
    expect(res !== 'HUNG' && textOf(res)).toContain('the page waits for your answer')
    gate.release()
    const answered = await fake.call(s, 'browser_respond_prompt', {
      tabId: tab,
      action: 'sign-in',
      username: 'me',
      password: 'pw'
    })
    expect(answered.isError, textOf(answered)).toBeFalsy()
    expect(await handle!.result).toEqual({ username: 'me', password: 'pw' })
  })

  it('an unanswered prompt gets its default; a closed tab its refusal', async () => {
    const fake = browser()
    fake.service.promptTtlMs = 40
    const s = await fake.connect('cam')
    const tab = await openTab(fake, s, 'https://cam.test')
    const asked = fake.service.routePrompt(permissionSpec(camera(tab)))
    expect(await settle(asked!.result, 500)).toBeNull()
    fake.service.promptTtlMs = 60_000
    const saving = fake.service.downloadDestination(tab, download())
    const other = await openTab(fake, s, 'https://cam.test/2')
    const choosing = fake.service.onFileChooser(other, {
      mode: 'single',
      accept: [],
      source: 'input'
    })
    fake.user.closeTab(other)
    expect(await settle(choosing, 200)).toEqual({ kind: 'cancel' })
    fake.service.releaseTab(tab)
    expect(await settle(saving!, 200)).toEqual({ kind: 'cancel' })
  })

  it("refuses answers to another agent's prompt", async () => {
    const fake = browser()
    const a = await fake.connect('a')
    const b = await fake.connect('b')
    const tab = await openTab(fake, a, 'https://cam.test')
    const asked = fake.service.routePrompt(permissionSpec(camera(tab)))
    const res = await fake.call(b, 'browser_respond_prompt', {
      promptId: asked!.id,
      action: 'allow'
    })
    expect(res.isError).toBe(true)
    expect(textOf(await fake.call(b, 'zen_status'))).not.toContain(asked!.id)
    await fake.call(a, 'browser_respond_prompt', { promptId: asked!.id, action: 'allow' })
    expect(await asked!.result).toBe('allow-once')
  })

  it('print and save pickers are kept from the user and told to the agent', async () => {
    const fake = browser()
    const s = await fake.connect('printer')
    const tab = await openTab(fake, s, 'https://invoice.test')
    expect(fake.service.onPagePrompt(tab, { kind: 'print' })).toBe('agent')
    expect(fake.service.onPagePrompt(tab, { kind: 'file-system-access', picker: 'save' })).toBe(
      'agent'
    )
    expect(fake.service.onPagePrompt(tab, { kind: 'file-system-access', picker: 'open' })).toBe(
      'agent'
    )
    const status = textOf(await fake.call(s, 'zen_status'))
    expect(status).toContain('called window.print(); nothing was printed')
    expect(status).toContain('save-file picker (File System Access)')
  })
})

describe('browser_file_upload and pickers in the page', () => {
  it('sets the files of an input without a click, and drops them on a drop zone', async () => {
    const fake = browser()
    const s = await fake.connect('uploader')
    const tab = await openTab(fake, s, 'https://docs.test')
    fake.pages.set(tab, uploadPage('https://docs.test'))
    const set = await fake.call(s, 'browser_file_upload', {
      tabId: tab,
      target: 'text=Attachment',
      paths: ['/tmp/a.pdf']
    })
    expect(set.isError, textOf(set)).toBeFalsy()
    expect(textOf(set)).toContain('(it accepts .pdf)')
    const [first] = fake.uploads.get(tab) ?? []
    expect(first.selector).toMatch(/^\[data-zen-upload="u\w+"\]$/)
    expect(first.files).toEqual([{ path: '/tmp/a.pdf' }])
    expect(fake.input.get(tab)).toEqual([])

    const notInput = await fake.call(s, 'browser_file_upload', {
      tabId: tab,
      target: 'text=Drop files here',
      paths: ['/tmp/a.pdf']
    })
    expect(notInput.isError).toBe(true)
    expect(textOf(notInput)).toContain('drop: true')
    const dropped = await fake.call(s, 'browser_file_upload', {
      tabId: tab,
      target: 'text=Drop files here',
      drop: true,
      files: [{ name: 'b.png', base64: 'aGk=' }]
    })
    expect(dropped.isError, textOf(dropped)).toBeFalsy()
    expect(fake.uploads.get(tab)?.[1]).toMatchObject({ x: 170, files: [{ name: 'b.png' }] })
  })

  it('refuses to click a drop-down select open and points at browser_select_option', async () => {
    const fake = browser()
    const s = await fake.connect('former')
    const tab = await openTab(fake, s, 'https://form.test')
    fake.pages.set(tab, uploadPage('https://form.test'))
    const res = await fake.call(s, 'browser_click', { tabId: tab, target: 'text=Country' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('browser_select_option')
    expect(fake.input.get(tab)).toEqual([])
  })
})

function download(): { url: string; filename: string; mimeType: string; totalBytes: number } {
  return {
    url: 'https://x.test/a.zip',
    filename: 'a.zip',
    mimeType: 'application/zip',
    totalBytes: 3
  }
}
