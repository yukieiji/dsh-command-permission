/**
 * Command Permission — Host half.
 *
 * Prepends an `approval/request` listener that decides shell-command escalations
 * from three lists before the user is ever asked:
 *
 * 1. workspace deny list    -> always `rejected`
 * 2. workspace allow list   -> always `allowed-once`
 * 3. session allow grants   -> always `allowed-once` (per session, persisted)
 *
 * Everything lives in `<workspace>/.dsh/command-permissions.json`:
 * `{ "allow": [...], "deny": [...], "session": { "<sessionId>": [...] } }`.
 *
 * Pattern semantics: without `*` a pattern equals the command exactly;
 * `*` is a wildcard matching any run of characters, usable at any position
 * (`uv run *`, `* --force`, `git * push`). Whitespace is normalized on both sides.
 *
 * The plugin is plain JavaScript at runtime, so the Host surface is typed
 * structurally here: only the members this plugin actually touches.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/* ------------------------------------------------------------------ types */

/** One tool-call event payload the listener reads. */
interface ToolCallData {
  readonly callId?: unknown
  readonly arguments?: unknown
}

/** One session event as seen through the structural seam. */
interface SessionEventLike {
  readonly type: string
  readonly data?: ToolCallData
}

/** The Session members this plugin touches. */
interface SessionLike {
  readonly id: unknown
  readonly seq: number
  eventAt(seq: number): SessionEventLike | undefined
}

/** The approval request as seen through the structural seam. */
interface ApprovalRequestLike {
  readonly agent: { readonly session: SessionLike }
  readonly callId?: string
}

/** One registered workspace as seen through the structural seam. */
interface WorkspaceLike {
  readonly path: string
  readonly sessionIds: readonly unknown[]
}

/** The workspace registry members this plugin touches. */
interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
}

/** One command invocation as seen through the structural seam. */
interface CommandInvocationLike {
  readonly agent: { readonly session: SessionLike }
  readonly rawInput: string
}

/** Command handler outcome in the registry's own vocabulary. */
export interface CommandResultLike {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** The Host context members this plugin touches. */
export interface HostContext {
  readonly workspaceRegistry: WorkspaceRegistryLike
  readonly commands: {
    register(definition: {
      readonly name: string
      readonly description: string
      readonly input?: { readonly hint: string }
      readonly handler: (invocation: CommandInvocationLike) => CommandResultLike
    }): () => void
  }
  readonly logger: { warn(message: string): void }
  on(
    event: 'approval/request',
    listener: (request: ApprovalRequestLike, next: () => Promise<string>) => Promise<string>,
    options?: { readonly prepend?: boolean },
  ): () => void
  effect(body: () => (() => void) | void, label?: string): void
}

/** One workspace's allow/deny lists plus the per-session grants. */
export interface Lists {
  allow: string[]
  deny: string[]
  session: Record<string, string[]>
}

/* --------------------------------------------------------------- matching */

/** Collapse runs of whitespace so `git  push` and `git push` compare equal. */
const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')

/** Escape every regex metacharacter except the wildcard split done by the caller. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A pattern without `*` matches only the identical command; `*` is a wildcard
 * matching any run of characters and may appear at any position.
 */
export function matchesPattern(command: string, pattern: string): boolean {
  const normalizedPattern = normalize(pattern)
  if (normalizedPattern.length === 0) {
    return false
  }
  const source = normalizedPattern.split('*').map(escapeRegExp).join('[\\s\\S]*')
  return new RegExp(`^${source}$`).test(normalize(command))
}

/** Whether any pattern matches the command. */
const matchesAny = (command: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern => matchesPattern(command, pattern))

/** Resolve the shell command of the tool call an approval request correlates with. */
function resolveCommand(request: ApprovalRequestLike): string | undefined {
  const callId = request.callId
  if (callId === undefined) {
    return undefined
  }
  const session = request.agent.session
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/call' || event.data?.callId !== callId) {
      continue
    }
    if (typeof event.data.arguments !== 'string') {
      return undefined
    }
    try {
      const parsed = ToolCallArgsSchema.safeParse(JSON.parse(event.data.arguments))
      if (parsed.success && parsed.data.command !== undefined) {
        return parsed.data.command
      }
    } catch {
      return undefined
    }
    return undefined
  }
  return undefined
}

/* ------------------------------------------------------------------ lists */

const LISTS_FILE = join('.dsh', 'command-permissions.json')

const emptyLists = (): Lists => ({ allow: [], deny: [], session: {} })

/** Tool-call arguments: only the optional shell `command` string is read. */
const ToolCallArgsSchema = z.looseObject({ command: z.string().optional() })

/** One pattern line: strings survive (trimmed), anything else drops out. */
const patternItem = z.unknown().transform(value => (typeof value === 'string' ? value.trim() : ''))

/** A pattern list: non-arrays become empty, empty entries drop out. */
const patternList = z
  .array(patternItem)
  .transform(items => items.filter(item => item.length > 0))
  .catch([])

/** The `{ sessionId: patterns }` map: malformed shapes become empty. */
const sessionMap = z
  .record(z.string(), patternList)
  .transform(entries => Object.fromEntries(Object.entries(entries).filter(([, patterns]) => patterns.length > 0)))
  .catch({})

/** The whole `command-permissions.json` document; every field degrades to empty. */
const ListsSchema = z.object({
  allow: patternList.catch([]),
  deny: patternList.catch([]),
  session: sessionMap.catch({}),
})

/** Parse an untrusted JSON document into `{ allow, deny, session }`. */
export function sanitizeLists(raw: unknown): Lists {
  const parsed = ListsSchema.safeParse(raw)
  if (!parsed.success) {
    return emptyLists()
  }
  return parsed.data
}

/* ----------------------------------------------------------------- apply */

export const inject = ['workspaceRegistry', 'commands']

export function apply(ctx: HostContext): void {
  /** Workspace file cache keyed by path, invalidated by mtime. */
  const fileCache = new Map<string, { mtimeMs: number; lists: Lists }>()

  const readLists = (workspacePath: string): Lists => {
    const file = join(workspacePath, LISTS_FILE)
    try {
      const mtimeMs = statSync(file).mtimeMs
      const cached = fileCache.get(workspacePath)
      if (cached !== undefined && cached.mtimeMs === mtimeMs) {
        return cached.lists
      }
      const lists = sanitizeLists(JSON.parse(readFileSync(file, 'utf8')))
      fileCache.set(workspacePath, { mtimeMs, lists })
      return lists
    } catch {
      return emptyLists()
    }
  }

  const writeLists = (workspacePath: string, lists: Lists): void => {
    const dir = join(workspacePath, '.dsh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'command-permissions.json'), `${JSON.stringify(lists, undefined, 2)}\n`, 'utf8')
    fileCache.delete(workspacePath)
  }

  const workspacePathOf = (workspaceId: string): string => {
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new Error(`unknown workspace '${workspaceId}'`)
    }
    return workspace.path
  }

  /** The workspace owning a session; throws when the session belongs to none. */
  const workspacePathOfSession = (session: SessionLike): string => {
    const sessionId = String(session.id)
    const workspace = ctx.workspaceRegistry
      .list()
      .find(candidate => candidate.sessionIds.some(id => String(id) === sessionId))
    if (workspace === undefined) {
      throw new Error(`session '${sessionId}' belongs to no workspace`)
    }
    return workspace.path
  }

  const listsForSession = (session: SessionLike): Lists => {
    const sessionId = String(session.id)
    const workspace = ctx.workspaceRegistry
      .list()
      .find(candidate => candidate.sessionIds.some(id => String(id) === sessionId))
    if (workspace === undefined) {
      return emptyLists()
    }
    return readLists(workspace.path)
  }

  /** Read-modify-write one session's persisted grants; returns the new list. */
  const mutateSessionGrants = (
    workspacePath: string,
    sessionId: string,
    mutate: (grants: string[]) => string[],
  ): string[] => {
    const lists = readLists(workspacePath)
    const grants = mutate([...(lists.session[sessionId] ?? [])])
    if (grants.length === 0) {
      delete lists.session[sessionId]
    } else {
      lists.session[sessionId] = grants
    }
    writeLists(workspacePath, lists)
    return grants
  }

  /** Read-modify-write one workspace list (`allow` or `deny`). */
  const mutateWorkspaceList = (workspacePath: string, list: 'allow' | 'deny', pattern: string): string[] => {
    const lists = readLists(workspacePath)
    if (!lists[list].includes(pattern)) {
      lists[list].push(pattern)
    }
    writeLists(workspacePath, lists)
    return lists[list]
  }

  /* ------------------------------------------------------ approval listener */

  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    try {
      const command = resolveCommand(request)
      if (command !== undefined) {
        const sessionId = String(request.agent.session.id)
        const lists = listsForSession(request.agent.session)
        if (matchesAny(command, lists.deny)) {
          return Promise.resolve('rejected')
        }
        if (matchesAny(command, lists.allow)) {
          return Promise.resolve('allowed-once')
        }
        if (matchesAny(command, lists.session[sessionId] ?? [])) {
          return Promise.resolve('allowed-once')
        }
      }
    } catch (error) {
      ctx.logger.warn(`command-permission: approval listener failure: ${String(error)}`)
    }
    return next()
  }, { prepend: true }), 'command-permission: approval listener')

  /* ------------------------------------------------------------ /cmdperm */

  const ok = (payload: unknown): CommandResultLike => ({ kind: 'success', text: JSON.stringify(payload) })
  const fail = (message: string): CommandResultLike => ({ kind: 'error', text: message })

  const handleCommand = (invocation: CommandInvocationLike): CommandResultLike => {
    const input = invocation.rawInput.trim()
    const session = invocation.agent.session
    const sessionId = String(session.id)
    try {
      if (input === 'session list') {
        const grants = readLists(workspacePathOfSession(session)).session[sessionId] ?? []
        return ok({ session: grants })
      }
      if (input === 'session clear') {
        mutateSessionGrants(workspacePathOfSession(session), sessionId, () => [])
        return ok({ session: [] })
      }
      const sessionAdd = /^session add ([\s\S]+)$/.exec(input)
      if (sessionAdd !== null) {
        const pattern = sessionAdd[1].trim()
        if (pattern.length === 0) {
          return fail('empty pattern')
        }
        const grants = mutateSessionGrants(workspacePathOfSession(session), sessionId, existing =>
          existing.includes(pattern) ? existing : [...existing, pattern])
        return ok({ session: grants })
      }
      const sessionRemove = /^session remove ([\s\S]+)$/.exec(input)
      if (sessionRemove !== null) {
        const pattern = sessionRemove[1].trim()
        const grants = mutateSessionGrants(workspacePathOfSession(session), sessionId,
          existing => existing.filter(item => item !== pattern))
        return ok({ session: grants })
      }
      const workspaceAdd = /^workspace (allow|deny) add ([\s\S]+)$/.exec(input)
      if (workspaceAdd !== null) {
        const pattern = workspaceAdd[2].trim()
        if (pattern.length === 0) {
          return fail('empty pattern')
        }
        const lists = mutateWorkspaceList(workspacePathOfSession(session), workspaceAdd[1] as 'allow' | 'deny', pattern)
        return ok({ [workspaceAdd[1]]: lists })
      }
      const workspaceList = /^workspace (\S+) list$/.exec(input)
      if (workspaceList !== null) {
        const path = workspacePathOf(workspaceList[1])
        return ok({ path, ...readLists(path) })
      }
      const workspaceSave = /^workspace (\S+) save ([\s\S]+)$/.exec(input)
      if (workspaceSave !== null) {
        const path = workspacePathOf(workspaceSave[1])
        const incoming = sanitizeLists(JSON.parse(workspaceSave[2]))
        // The dialog edits only allow/deny; keep the persisted session grants.
        const session = readLists(path).session
        writeLists(path, { ...incoming, session: Object.keys(incoming.session).length > 0 ? incoming.session : session })
        return ok({ path, saved: true })
      }
      return fail('usage: /cmdperm session add|remove|list|clear | /cmdperm workspace allow|deny add <pattern> | /cmdperm workspace <id> list|save <json>')
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'cmdperm',
    description: 'Manage command permission lists (command-permission plugin)',
    input: { hint: 'session add <pattern> | session list | workspace allow add <pattern> | workspace <id> list' },
    handler: handleCommand,
  }), 'command-permission: /cmdperm command')
}
