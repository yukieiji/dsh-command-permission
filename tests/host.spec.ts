/** Host-half unit tests: pattern matching, list persistence, and the approval decision order. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, matchesPattern, sanitizeLists } from '../src/index.ts'
import type { HostContext } from '../src/index.ts'

/* ------------------------------------------------------------- fixtures */

type ApprovalListener = (request: any, next: () => Promise<string>) => Promise<string>
type CommandHandler = (invocation: { agent: { session: unknown }; rawInput: string }) => { kind: 'success' | 'error'; text?: string }

interface Harness {
  listener: ApprovalListener
  command: CommandHandler
  warn: string[]
  session(sessionId: string, events?: Record<number, unknown>): unknown
}

const toolCall = (callId: string, args: unknown) => ({
  type: 'tool/call',
  data: { callId, arguments: JSON.stringify(args) },
})

const defaultEvents: Record<number, unknown> = {
  1: toolCall('c1', { command: 'uv run app.py', sandbox_permissions: 'danger-full-access' }),
}

function createHarness(workspacePath?: string): Harness {
  const listeners: ApprovalListener[] = []
  const handlers: CommandHandler[] = []
  const warn: string[] = []
  const workspaces = workspacePath === undefined
    ? []
    : [{ id: 'ws1', path: workspacePath, sessionIds: ['s1'] }]
  const ctx = {
    workspaceRegistry: {
      list: () => workspaces,
      get: (id: string) => workspaces.find(workspace => workspace.id === id),
    },
    commands: {
      register: (definition: any) => {
        handlers.push(definition.handler)
        return () => {}
      },
    },
    logger: { warn: (message: string) => { warn.push(message) } },
    on: (_event: string, listener: ApprovalListener) => {
      listeners.push(listener)
      return () => {}
    },
    effect: (body: () => any) => { body() },
  } as unknown as HostContext
  apply(ctx)

  return {
    listener: listeners[0],
    command: rawInvocation => handlers[0](rawInvocation),
    warn,
    session: (sessionId, events) => ({
      id: sessionId,
      seq: 3,
      eventAt: (seq: number) => (events ?? defaultEvents)[seq],
    }),
  }
}

const ask = (harness: Harness, session: unknown, callId: string | undefined = 'c1') =>
  harness.listener({ agent: { session }, ...(callId === undefined ? {} : { callId }) }, async () => 'PASSED-THROUGH')

const listsFile = (workspacePath: string) => join(workspacePath, '.dsh', 'command-permissions.json')

const readSaved = (workspacePath: string) => JSON.parse(readFileSync(listsFile(workspacePath), 'utf8'))

/* ---------------------------------------------------------------- tests */

describe('matchesPattern', () => {
  it('matches the exact command', () => {
    expect(matchesPattern('uv run app.py', 'uv run app.py')).toBe(true)
  })

  it('without a star matches only the identical command', () => {
    expect(matchesPattern('uv run app.py', 'uv run')).toBe(false)
    expect(matchesPattern('uv run app.py', 'uv')).toBe(false)
  })

  it('a trailing star wildcard extends the prefix', () => {
    expect(matchesPattern('uv run app.py', 'uv run *')).toBe(true)
    expect(matchesPattern('uv run', 'uv run *')).toBe(false)
    expect(matchesPattern('uv run app.py', 'uv *')).toBe(true)
    expect(matchesPattern('uvx run app.py', 'uv *')).toBe(false)
  })

  it('a leading star wildcard matches any opening', () => {
    expect(matchesPattern('git push --force', '* --force')).toBe(true)
    expect(matchesPattern('git push', '* --force')).toBe(false)
    expect(matchesPattern('gitpush', '*push')).toBe(true)
  })

  it('a middle star wildcard matches between literals', () => {
    expect(matchesPattern('git push origin', 'git * origin')).toBe(true)
    expect(matchesPattern('git push', 'git * origin')).toBe(false)
  })

  it('never matches mid-command text without a star', () => {
    expect(matchesPattern('echo uv run', 'uv')).toBe(false)
  })

  it('normalizes whitespace runs on both sides', () => {
    expect(matchesPattern('git  push  origin', 'git push origin')).toBe(true)
    expect(matchesPattern('git  push  origin', 'git * origin')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    expect(matchesPattern('echo a+b', 'echo a+b')).toBe(true)
    expect(matchesPattern('echo axxb', 'echo a+b')).toBe(false)
    expect(matchesPattern('echo a.b', 'echo a*b')).toBe(true)
  })

  it('rejects empty patterns', () => {
    expect(matchesPattern('uv run', '   ')).toBe(false)
  })
})

describe('sanitizeLists', () => {
  it('keeps non-empty strings, trims them, and drops everything else', () => {
    expect(sanitizeLists({ allow: ['uv run', '', 1, null, ' git status '], deny: 'nope' }))
      .toEqual({ allow: ['uv run', 'git status'], deny: [], session: {} })
  })

  it('keeps well-formed session maps and drops empty entries', () => {
    expect(sanitizeLists({ session: { s1: ['uv *'], s2: [], s3: 'no' } }))
      .toEqual({ allow: [], deny: [], session: { s1: ['uv *'] } })
  })

  it('survives non-object documents and malformed fields', () => {
    expect(sanitizeLists(null)).toEqual({ allow: [], deny: [], session: {} })
    expect(sanitizeLists('allow')).toEqual({ allow: [], deny: [], session: {} })
    expect(sanitizeLists({ allow: 'uv run', session: 'nope' })).toEqual({ allow: [], deny: [], session: {} })
  })
})

describe('approval decisions', () => {
  let workspacePath: string
  let harness: Harness

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'cmdperm-'))
    harness = createHarness(workspacePath)
  })

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true })
  })

  const command = (rawInput: string, sessionId = 's1') =>
    harness.command({ agent: { session: harness.session(sessionId) }, rawInput })

  const askDefault = (h: Harness = harness) => ask(h, h.session('s1'))

  it('passes through when no list matches', async () => {
    expect(await askDefault()).toBe('PASSED-THROUGH')
  })

  it('auto-allows a workspace allow-list match and persists the file', async () => {
    command('workspace ws1 save {"allow":["uv run *"],"deny":[]}')
    expect(await askDefault()).toBe('allowed-once')
    expect(readSaved(workspacePath).allow).toEqual(['uv run *'])
  })

  it('rejects a deny-list match even when the allow list also matches', async () => {
    command('workspace ws1 save {"allow":["uv run *"],"deny":["uv *"]}')
    expect(await askDefault()).toBe('rejected')
  })

  it('re-reads the file after an external edit', async () => {
    command('workspace ws1 save {"allow":["uv run *"],"deny":[]}')
    expect(await askDefault()).toBe('allowed-once')
    mkdirSync(join(workspacePath, '.dsh'), { recursive: true })
    writeFileSync(listsFile(workspacePath), JSON.stringify({ allow: [], deny: ['uv *'], session: {} }), 'utf8')
    expect(await askDefault()).toBe('rejected')
  })

  it('adds a pattern to the workspace allow list through the command', async () => {
    expect(command('workspace allow add uv run *').kind).toBe('success')
    expect(await askDefault()).toBe('allowed-once')
    expect(readSaved(workspacePath).allow).toEqual(['uv run *'])
  })

  it('adds a pattern to the workspace deny list through the command', async () => {
    command('workspace deny add git push*')
    expect(readSaved(workspacePath).deny).toEqual(['git push*'])
  })

  it('does not duplicate an existing workspace pattern', () => {
    command('workspace allow add uv run *')
    command('workspace allow add uv run *')
    expect(readSaved(workspacePath).allow).toEqual(['uv run *'])
  })

  it('persists session grants into the file', async () => {
    expect(command('session add uv run *').kind).toBe('success')
    expect(await askDefault()).toBe('allowed-once')
    expect(readSaved(workspacePath).session).toEqual({ s1: ['uv run *'] })
  })

  it('keeps session grants across plugin restarts', async () => {
    command('session add uv *')
    const restarted = createHarness(workspacePath)
    expect(await ask(restarted, restarted.session('s1'))).toBe('allowed-once')
  })

  it('lists and clears session grants', async () => {
    command('session add uv run *')
    expect(command('session list').text).toBe(JSON.stringify({ session: ['uv run *'] }))
    command('session clear')
    expect(await askDefault()).toBe('PASSED-THROUGH')
    expect(readSaved(workspacePath).session).toEqual({})
  })

  it('removes a single session pattern', () => {
    command('session add uv run *')
    command('session add uv *')
    command('session remove uv run *')
    expect(command('session list').text).toBe(JSON.stringify({ session: ['uv *'] }))
  })

  it('keeps session grants per session', async () => {
    command('session add uv *')
    expect(await askDefault()).toBe('allowed-once')
    expect(await ask(harness, harness.session('other'))).toBe('PASSED-THROUGH')
  })

  it('a workspace save keeps the persisted session grants', () => {
    command('session add uv *')
    command('workspace ws1 save {"allow":["git status"],"deny":[]}')
    expect(readSaved(workspacePath)).toEqual({ allow: ['git status'], deny: [], session: { s1: ['uv *'] } })
  })

  it('passes through approvals without a callId or command', async () => {
    expect(await ask(harness, harness.session('s1'), undefined)).toBe('PASSED-THROUGH')
    const fsEvents = { 1: toolCall('c1', { file_path: 'x' }) }
    expect(await ask(harness, harness.session('s1', fsEvents), 'c1')).toBe('PASSED-THROUGH')
  })

  it('reports unknown workspace ids as command errors', () => {
    expect(command('workspace nope list').kind).toBe('error')
  })

  it('reports a usage error for unknown grammar', () => {
    expect(command('nonsense').kind).toBe('error')
  })

  it('reports an error for session grants without a workspace', () => {
    const orphan = createHarness()
    expect(orphan.command({ agent: { session: orphan.session('s9') }, rawInput: 'session add uv' }).kind).toBe('error')
  })

  it('passes through and warns when the session seam throws', async () => {
    const brokenSession = { id: 's1', get seq(): number { throw new Error('boom') } }
    expect(await ask(harness, brokenSession, 'c1')).toBe('PASSED-THROUGH')
    expect(harness.warn.length).toBe(1)
    expect(harness.warn[0]).toContain('boom')
  })
})
