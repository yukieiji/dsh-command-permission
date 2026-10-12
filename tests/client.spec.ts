/** Client-half unit tests: module registration, tier buttons, and the grant-and-answer flow. */

import { beforeAll, describe, expect, it } from 'vitest'

interface LoadedModule {
  id: string
  factory: (require: (name: string) => unknown) => ClientPlugin
}
interface ClientPlugin {
  inject?: string[]
  apply: (ctx: any) => void
}

const loaded: LoadedModule[] = []

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: { load: (spec: LoadedModule) => { loaded.push(spec) } },
  }
  await import('../src/client.ts')
})

/** Collect every text child of a rendered fake-React tree. */
function textsOf(node: unknown, into: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return into
  }
  if (typeof node === 'string') {
    into.push(node)
    return into
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      textsOf(child, into)
    }
    return into
  }
  textsOf((node as { children?: unknown }).children, into)
  return into
}

function createClient(options: {
  execute?: (sessionId: string, line: string) => Promise<any>
  pendingInteraction?: unknown
} = {}) {
  const executed: Array<[string, string]> = []
  const registrations: Array<{ options: any; component: any }> = []
  const ctx = {
    locale: { register: (_ns: string, dicts: unknown) => { ctx.__dicts = dicts } },
    slots: {
      inject: (_slot: string, factory: () => { options: any; component: any }) => {
        registrations.push(factory())
        return () => {}
      },
      register: (options: any, component: any) => ({ options, component }),
    },
    remote: {
      commands: {
        execute: async (sessionId: string, line: string, attachments: unknown[]) => {
          executed.push([sessionId, line])
          void attachments
          if (options.execute !== undefined) {
            return options.execute(sessionId, line)
          }
          return { ok: true, value: { result: { kind: 'success', text: JSON.stringify({ allow: ['uv run'], deny: [] }) } } }
        },
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) } },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => new Map([['s1', { pendingInteraction: options.pendingInteraction }]]),
      },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws1', title: 'WS', path: 'C:/ws' }] }) } },
    __dicts: undefined as any,
  }
  const plugin = loaded[0].factory(name => {
    if (name === 'react') {
      return {
        createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]) => ({
          type,
          props: props ?? {},
          children: children.flat(Infinity),
        }),
        useState: (init: unknown) => [init, () => {}],
        useEffect: () => {},
        Fragment: 'fragment',
      }
    }
    throw new Error(`unexpected require: ${String(name)}`)
  })
  plugin.apply(ctx)
  return { ctx, registrations, executed }
}

const chatSnapshot = (argsRaw: string, callId = 'c1') => ({
  nodes: new Map([['n', { kind: 'tool-call', data: { root: { callId, phase: 'start', argsRaw } } }]]),
})

const t = (key: string, params?: { pattern?: string }) =>
  `${key}${params?.pattern === undefined ? '' : `:${params.pattern}`}`

describe('client module', () => {
  it('registers under the published package id', () => {
    expect(loaded.length).toBe(1)
    expect(loaded[0].id).toBe('@yukieiji/dsh-command-permission')
  })

  it('registers the approval detail at shadowing priority and the shell overlay', () => {
    const { registrations } = createClient()
    expect(registrations.length).toBe(2)
    expect(registrations[0].options.name).toBe('conversation.approval.detail')
    expect(registrations[0].options.priority).toBe(-1)
    expect(registrations[1].options.name).toBe('shell.overlay')
    expect(registrations[1].options.id).toBe('command-permission-menus')
  })

  it('registers both dictionaries with the tier labels', () => {
    const { ctx } = createClient()
    expect(ctx.__dicts.en.allowSession).toBe('Allow “{pattern}” for this session')
    expect(ctx.__dicts.en.allowWorkspace).toBe('Add “{pattern}” to the workspace allow list')
    expect(ctx.__dicts.ja.allowSession).toBe('このセッション中「{pattern}」を許可')
    expect(ctx.__dicts.ja.allowWorkspace).toBe('ワークスペース許可リストに「{pattern}」を追加')
  })

  it('renders session and workspace tier buttons for a three-word command', () => {
    const { registrations } = createClient()
    const detail = registrations[0].component
    const injected = registrations[0].options.inject()
    const tree = detail({
      callId: 'c1',
      sessionId: 's1',
      useChat: (selector: (snapshot: unknown) => unknown) => selector(chatSnapshot(JSON.stringify({ command: 'uv run app.py' }))),
      t,
      ...injected,
    })
    const texts = textsOf(tree)
    expect(texts.filter(text => text.startsWith('allowSession:'))).toEqual([
      'allowSession:uv run app.py',
      'allowSession:uv run *',
      'allowSession:uv *',
    ])
    expect(texts.filter(text => text.startsWith('allowWorkspace:'))).toEqual([
      'allowWorkspace:uv run app.py',
      'allowWorkspace:uv run *',
      'allowWorkspace:uv *',
    ])
  })

  it('renders two tiers for a two-word command and one for a single word', () => {
    const { registrations } = createClient()
    const detail = registrations[0].component
    const injected = registrations[0].options.inject()
    const render = (command: string) => textsOf(detail({
      callId: 'c1',
      sessionId: 's1',
      useChat: (selector: (snapshot: unknown) => unknown) => selector(chatSnapshot(JSON.stringify({ command }))),
      t,
      ...injected,
    })).filter(text => text.startsWith('allowSession:'))
    expect(render('uv run')).toEqual(['allowSession:uv run', 'allowSession:uv *'])
    expect(render('uv')).toEqual(['allowSession:uv'])
  })

  it('renders nothing for approvals whose call carries no command', () => {
    const { registrations } = createClient()
    const detail = registrations[0].component
    const injected = registrations[0].options.inject()
    const tree = detail({
      callId: 'c2',
      sessionId: 's1',
      useChat: (selector: (snapshot: unknown) => unknown) => selector(chatSnapshot(JSON.stringify({ file_path: 'x' }), 'c2')),
      t,
      ...injected,
    })
    expect(tree).toBeNull()
  })

  it('grants the pattern through /cmdperm and answers the pending approval', async () => {
    let answered: string | undefined
    const { registrations, executed } = createClient({
      pendingInteraction: {
        kind: 'approval',
        callId: 'c1',
        answerable: true,
        answer: (outcome: string) => {
          answered = outcome
        },
      },
    })
    const injected = registrations[0].options.inject()
    await injected.grantSessionPattern('s1', 'uv run *')
    expect(executed).toEqual([['s1', '/cmdperm session add uv run *']])
    injected.allowCurrent('s1', 'c1')
    expect(answered).toBe('allowed-once')
  })

  it('grants the pattern to the workspace allow list through /cmdperm', async () => {
    const { registrations, executed } = createClient()
    await registrations[0].options.inject().grantWorkspacePattern('s1', 'uv run *')
    expect(executed).toEqual([['s1', '/cmdperm workspace allow add uv run *']])
  })

  it('does not answer a pending approval for another call', () => {
    let answered: string | undefined
    const { registrations } = createClient({
      pendingInteraction: {
        kind: 'approval',
        callId: 'other',
        answerable: true,
        answer: (outcome: string) => {
          answered = outcome
        },
      },
    })
    registrations[0].options.inject().allowCurrent('s1', 'c1')
    expect(answered).toBeUndefined()
  })

  it('surfaces a failed command as a rejection', async () => {
    const { registrations } = createClient({
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: 'no such grammar' } } }),
    })
    await expect(registrations[0].options.inject().grantSessionPattern('s1', 'uv')).rejects.toThrow('no such grammar')
  })

  it('surfaces a refused remote call as a rejection', async () => {
    const { registrations } = createClient({
      execute: async () => ({ ok: false, error: { code: 'unavailable', message: 'session gone' } }),
    })
    await expect(registrations[0].options.inject().grantSessionPattern('s1', 'uv')).rejects.toThrow('session gone')
  })

  it('names the plugin when the host command is missing', async () => {
    const { registrations } = createClient({
      execute: async () => ({ ok: true, value: undefined }),
    })
    await expect(registrations[0].options.inject().grantSessionPattern('s1', 'uv')).rejects.toThrow('command-permission plugin')
  })

  it('fails with the no-session message when no session holds the main view', async () => {
    const noSession = createClient()
    ;(noSession.ctx as any).sessions = { list: { getSnapshot: () => ({ byId: {} }) } }
    await expect(noSession.registrations[0].options.inject().grantSessionPattern('s1', 'uv')).rejects.toThrow('no session')
  })
})
