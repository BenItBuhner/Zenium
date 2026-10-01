import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpAuthPrompt, PermissionPrompt } from '../../../shared/types'
import { AgentPromptQueue, describePrompt, type AgentPrompt, type AgentPromptEnd } from '../prompts'
import {
  ANSWER_FROM_THIS_COMPUTER,
  MAX_INLINE_UPLOAD_BYTES,
  clientCertificateSpec,
  deviceChooserSpec,
  downloadSpec,
  fileChooserSpec,
  httpAuthSpec,
  permissionSpec,
  screenCaptureSpec,
  uploadFiles
} from '../nativePrompts'

function queue(): {
  q: AgentPromptQueue
  opened: AgentPrompt[]
  ended: Array<{ id: string; how: AgentPromptEnd; action: string }>
} {
  const opened: AgentPrompt[] = []
  const ended: Array<{ id: string; how: AgentPromptEnd; action: string }> = []
  const q = new AgentPromptQueue({
    now: () => Date.now(),
    opened: (p) => opened.push(p),
    ended: (p, how, action) => ended.push({ id: p.id, how, action })
  })
  return { q, opened, ended }
}

const chooser = (
  tabId: string,
  mode: 'single' | 'multiple' | 'folder' = 'single'
): ReturnType<typeof fileChooserSpec> & { ttlMs: number } => ({
  ...fileChooserSpec(tabId, { mode, accept: ['.pdf'], source: 'input' }),
  ttlMs: 120_000
})

describe('AgentPromptQueue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("queues per tab, oldest first, and hands the caller the agent's answer", async () => {
    const { q, opened, ended } = queue()
    const a = q.open(chooser('t1'))
    const b = q.open(chooser('t2'))
    expect(opened.map((p) => p.id)).toEqual([a.id, b.id])
    expect(q.list().map((p) => p.id)).toEqual([a.id, b.id])
    expect(q.list('t2').map((p) => p.id)).toEqual([b.id])
    q.answer(a.id, { action: 'upload', paths: ['/tmp/a.pdf'], [ANSWER_FROM_THIS_COMPUTER]: true })
    await expect(a.result).resolves.toEqual({ kind: 'files', files: [{ path: '/tmp/a.pdf' }] })
    expect(ended).toEqual([{ id: a.id, how: 'answered', action: 'upload' }])
    expect(q.list().map((p) => p.id)).toEqual([b.id])
  })

  it('keeps the prompt open on an answer that does not fit, and says why', () => {
    const { q } = queue()
    const a = q.open(chooser('t1'))
    expect(() => q.answer(a.id, { action: 'allow' })).toThrow(/takes action "upload", "cancel"/)
    expect(() => q.answer(a.id, { action: 'upload' })).toThrow(/Name the files/)
    expect(q.get(a.id)).toBeDefined()
    expect(() => q.answer('prompt_gone', { action: 'cancel' })).toThrow(/No prompt prompt_gone/)
  })

  it('applies the default once the prompt waited its time out', async () => {
    const { q, ended } = queue()
    const d = q.open({
      ...downloadSpec('t1', {
        url: 'https://x.test/a.zip',
        filename: 'a.zip',
        mimeType: '',
        totalBytes: 0
      }),
      ttlMs: 1000
    })
    vi.advanceTimersByTime(999)
    expect(q.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await expect(d.result).resolves.toEqual({ kind: 'save', filename: null })
    expect(ended[0]).toMatchObject({ how: 'expired', action: 'save' })
  })

  it('dismisses with the refusal, never a grant, when the tab goes or the server stops', async () => {
    const { q, ended } = queue()
    const d = q.open({
      ...downloadSpec('t1', {
        url: 'https://x.test/a.zip',
        filename: 'a.zip',
        mimeType: '',
        totalBytes: 0
      }),
      ttlMs: 1000
    })
    const p = q.open({
      ...permissionSpec({ ...permission(), tabId: 't2' }),
      ttlMs: 1000
    })
    q.dismissTab('t1')
    await expect(d.result).resolves.toEqual({ kind: 'cancel' })
    q.dismissAll()
    await expect(p.result).resolves.toBeNull()
    expect(ended.map((e) => e.how)).toEqual(['dismissed', 'dismissed'])
    vi.advanceTimersByTime(5000)
    expect(ended).toHaveLength(2)
  })

  it('lets the caller update details and withdraw the request', async () => {
    const { q } = queue()
    let devices = [{ id: 'd1', name: 'Pen', detail: '' }]
    const h = q.open({
      ...deviceChooserSpec('t1', 'usb', 'https://x.test', () => devices),
      ttlMs: 1000
    })
    devices = [...devices, { id: 'd2', name: 'Key', detail: '' }]
    h.update({ candidates: devices })
    expect(q.get(h.id)?.details.candidates).toHaveLength(2)
    q.answer(h.id, { action: 'connect', deviceId: 'd2' })
    await expect(h.result).resolves.toBe('d2')
    const again = q.open({
      ...deviceChooserSpec('t1', 'usb', 'https://x.test', () => devices),
      ttlMs: 1000
    })
    again.close()
    await expect(again.result).resolves.toBeNull()
  })

  it('describes how to answer, with the parameter names the tools take', () => {
    const { q } = queue()
    const a = q.open(chooser('t1'))
    const text = describePrompt(q.get(a.id)!, Date.now())
    expect(text).toContain(`browser_file_upload {"promptId":"${a.id}"`)
    expect(text).toContain('"cancel" applies in 2 min')
    const p = q.open({ ...permissionSpec({ ...permission(), tabId: 't1' }), ttlMs: 30_000 })
    expect(describePrompt(q.get(p.id)!, Date.now())).toContain(
      `browser_respond_prompt {"promptId":"${p.id}","action":…}`
    )
  })
})

function permission(): PermissionPrompt {
  return {
    id: 'perm1',
    tabId: 't1',
    origin: 'https://cam.test',
    permission: 'camera',
    message: 'cam.test wants to use your camera',
    detail: '',
    allowOnce: true
  } as unknown as PermissionPrompt
}

describe('native prompt specs', () => {
  it("takes paths only from an agent on this computer, and checks the input's mode", () => {
    expect(uploadFiles({ paths: ['/a'] }, { local: true, mode: 'single' })).toEqual([
      { path: '/a' }
    ])
    expect(() => uploadFiles({ paths: ['/a'] }, { local: false, mode: 'single' })).toThrow(
      /another machine/
    )
    expect(
      uploadFiles({ files: [{ name: 'a.txt', base64: 'aGk=' }] }, { local: false, mode: 'single' })
    ).toEqual([{ name: 'a.txt', base64: 'aGk=' }])
    expect(() =>
      uploadFiles({ files: [{ name: '../a', base64: '' }] }, { local: false, mode: 'single' })
    ).toThrow(/not a file name/)
    expect(() => uploadFiles({ paths: ['/a', '/b'] }, { local: true, mode: 'single' })).toThrow(
      /one file, not 2/
    )
    expect(uploadFiles({ paths: ['/a', '/b'] }, { local: true, mode: 'multiple' })).toHaveLength(2)
    expect(() =>
      uploadFiles({ files: [{ name: 'a', base64: 'aGk=' }] }, { local: true, mode: 'folder' })
    ).toThrow(/folder path/)
    const big = 'A'.repeat(Math.ceil((MAX_INLINE_UPLOAD_BYTES * 4) / 3) + 8)
    expect(() =>
      uploadFiles({ files: [{ name: 'big', base64: big }] }, { local: true, mode: 'single' })
    ).toThrow(/capped/)
  })

  it("never turns an agent's permission answer into a lasting grant", () => {
    const spec = permissionSpec({ ...permission(), tabId: 't1' })
    expect(spec.kind).toBe('permission')
    expect(spec.decide({ action: 'allow' })).toBe('allow-once')
    expect(spec.decide({ action: 'deny' })).toBeNull()
    expect(
      permissionSpec({ ...permission(), tabId: 't1' }, { externalUrl: 'zoommtg://x' }).kind
    ).toBe('external-protocol')
  })

  it('blocks the page on sign-ins and certificates, and checks their arguments', () => {
    const auth = httpAuthSpec({
      host: 'intra.test',
      port: 443,
      realm: 'Staff',
      scheme: 'basic',
      isProxy: false,
      secure: true,
      failedBefore: false,
      tabId: 't1'
    } as unknown as HttpAuthPrompt & { tabId: string })
    expect(auth.blocking).toBe(true)
    expect(auth.summary).toBe('intra.test asks to sign in to "Staff".')
    expect(auth.decide({ action: 'sign-in', username: 'u', password: 'p' })).toEqual({
      username: 'u',
      password: 'p'
    })
    expect(() => auth.decide({ action: 'sign-in', username: 'u' })).toThrow(/"password"/)
    expect(auth.decide({ action: 'cancel' })).toBeNull()
    const cert = clientCertificateSpec('t1', 'mtls.test', [
      { subject: 'me', issuer: 'ca', validTo: 0 } as never
    ])
    expect(cert.decide({ action: 'select', index: 0 })).toBe(0)
    expect(() => cert.decide({ action: 'select', index: 3 })).toThrow(/0 to 0/)
    expect(cert.decide({ action: 'none' })).toBeNull()
  })

  it('offers screen capture of listed tabs only and keeps download names in the folder', () => {
    const cap = screenCaptureSpec('t1', 'https://meet.test', [
      { id: 'tab:t1', name: 'Meet' } as never
    ])
    expect(cap.decide({ action: 'share', sourceId: 'tab:t1' })).toBe('tab:t1')
    expect(() => cap.decide({ action: 'share', sourceId: 'screen:0' })).toThrow(/not on offer/)
    const dl = downloadSpec('t1', { url: 'u', filename: 'a.zip', mimeType: '', totalBytes: 10 })
    expect(dl.decide({ action: 'save', filename: 'b.zip' })).toEqual({
      kind: 'save',
      filename: 'b.zip'
    })
    expect(() => dl.decide({ action: 'save', filename: '../b.zip' })).toThrow(/not a file name/)
    expect(dl.decide({ action: 'cancel' })).toEqual({ kind: 'cancel' })
  })
})
