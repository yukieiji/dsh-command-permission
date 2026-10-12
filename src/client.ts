/**
 * Command Permission — Client half.
 *
 * 1. Approval detail (`conversation.approval.detail`, shadowing the shipped
 *    command display): shows the command plus tier buttons that grant a
 *    session-scoped allow pattern and answer the pending approval with
 *    `allowed-once` in one click.
 *       `uv run app.py` -> [uv run app.py] [uv run] [uv]
 * 2. Shell overlay: right-click a Workspace row in the sidebar to edit that
 *    Workspace's allow/deny lists (`.dsh/command-permissions.json`).
 *
 * Both talk to the Host through the `/cmdperm` session command.
 *
 * The browser module table hands this artifact a `require` for `react` only;
 * every Cordis service and slot prop arrives untyped through the plugin seam,
 * so this half intentionally works through `any` at that boundary. The one
 * real dependency (`zod`) is inlined by the rolldown client bundle.
 */

import { z } from 'zod'

interface ModuleLoader {
  load(spec: { id: string; factory: (require: (name: string) => unknown) => ClientPlugin }): void
}

interface ClientPlugin {
  inject?: string[]
  apply: (ctx: any) => void
}

declare global {
  interface Window {
    __ModuleLoader__: ModuleLoader
  }
}

window.__ModuleLoader__.load({
  id: '@yukieiji/dsh-command-permission',
  factory(require) {
    const React: any = require('react')
    const h: (...args: any[]) => any = React.createElement

    const NS = 'commandPermission'

    const en = {
      'allowSession': 'Allow “{pattern}” for this session',
      'allowWorkspace': 'Add “{pattern}” to the workspace allow list',
      'menu.item': 'Command permissions…',
      'dialog.title': 'Command permissions — {title}',
      'dialog.allow': 'Allow list (always OK)',
      'dialog.deny': 'Deny list (always reject, wins over allow)',
      'dialog.hint':
        'One pattern per line. Without * a pattern matches the command exactly; * is a wildcard at any position '
        + '(e.g. “uv run *”, “* --force”). Saved to .dsh/command-permissions.json in the workspace.',
      'dialog.save': 'Save',
      'dialog.cancel': 'Cancel',
      'dialog.noSession': 'Open a session first, then retry.',
      'dialog.error': 'Failed: {message}',
    }
    const ja = {
      'allowSession': 'このセッション中「{pattern}」を許可',
      'allowWorkspace': 'ワークスペース許可リストに「{pattern}」を追加',
      'menu.item': 'コマンド権限…',
      'dialog.title': 'コマンド権限 — {title}',
      'dialog.allow': '許可リスト（常にOK）',
      'dialog.deny': 'ブラックリスト（常に拒否・許可より優先）',
      'dialog.hint':
        '1行に1パターン。*が無ければ完全一致、*は任意位置で使えるワイルドカード（例:「uv run *」「* --force」）。'
        + 'ワークスペース内の .dsh/command-permissions.json に保存されます。',
      'dialog.save': '保存',
      'dialog.cancel': 'キャンセル',
      'dialog.noSession': 'セッションを開いてから再試行してください。',
      'dialog.error': '失敗: {message}',
    }

    /* -------------------------------------------------------------- helpers */

    const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')

    /** Tier patterns: exact command, then wildcard tiers `first two words *` and `first word *`. */
    function tiersOf(command: string): string[] {
      const tokens = normalize(command).split(' ').filter(token => token.length > 0)
      if (tokens.length === 0) {
        return []
      }
      const tiers = [tokens.join(' ')]
      if (tokens.length >= 3) {
        tiers.push(`${tokens.slice(0, 2).join(' ')} *`)
      }
      if (tokens.length >= 2) {
        tiers.push(`${tokens[0]} *`)
      }
      return [...new Set(tiers)]
    }

    /** Read the shell command out of a tool call's raw arguments. */
    const CommandArgsSchema = z.looseObject({ command: z.string().optional() })

    function commandOfArgs(argsRaw: unknown): string | undefined {
      if (typeof argsRaw !== 'string') {
        return undefined
      }
      try {
        const parsed = CommandArgsSchema.safeParse(JSON.parse(argsRaw))
        if (parsed.success) {
          return parsed.data.command
        }
      } catch {
        return undefined
      }
      return undefined
    }

    /** The `{ allow, deny }` payload the workspace list command answers with. */
    const CommandPayloadSchema = z.object({
      allow: z.array(z.string()).catch([]),
      deny: z.array(z.string()).catch([]),
    })

    /** Split a textarea value into trimmed, non-empty lines. */
    const linesOf = (value: string): string[] =>
      value.split('\n').map(line => line.trim()).filter(line => line.length > 0)

    const buttonStyle: Record<string, string> = {
      fontSize: '12px',
      padding: '3px 10px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-default, #8884)',
      background: 'var(--dsw-alias-surface-raised, transparent)',
      color: 'var(--dsw-alias-text-default, inherit)',
      cursor: 'pointer',
    }

    /** Inverted (black-on-light) fill so the tier buttons read as actions. */
    const tierButtonStyle: Record<string, string> = {
      fontSize: '12px',
      padding: '4px 10px',
      borderRadius: '6px',
      border: 'none',
      background: 'var(--dsw-alias-text-default, #1d1d1f)',
      color: 'var(--dsw-alias-surface-raised, #ffffff)',
      cursor: 'pointer',
    }

    const textareaStyle: Record<string, string> = {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      fontFamily: 'var(--dsw-alias-font-mono, monospace)',
      fontSize: '12px',
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-default, #8884)',
      background: 'var(--dsw-alias-surface-default, transparent)',
      color: 'inherit',
      resize: 'vertical',
    }

    /* -------------------------------------------------- Host command bridge */

    let ctx: any

    /** Run one /cmdperm line against the session currently open in the main view. */
    async function runCommand(noSessionMessage: string, line: string): Promise<unknown> {
      const list = ctx.sessions.list.getSnapshot()
      const carrier = Object.values(list.byId as Record<string, any>)
        .find((session: any) => (session.retainedBy?.mainView ?? 0) > 0)
      if (carrier === undefined) {
        throw new Error(noSessionMessage)
      }
      // The remote wraps the host execution: { ok:false, error } | { ok:true, value?: { result } }.
      const response = await ctx.remote.commands.execute(carrier.id, line, [])
      if (response?.ok !== true) {
        throw new Error(response?.error?.message ?? 'command.execute failed')
      }
      if (response.value === undefined) {
        throw new Error('unknown command /cmdperm — is the command-permission plugin enabled on the Host?')
      }
      const result = response.value.result
      if (result === undefined || result.kind !== 'success') {
        throw new Error(result?.text ?? 'command failed')
      }
      try {
        return JSON.parse(result.text ?? '{}')
      } catch {
        return {}
      }
    }

    /* -------------------------------------------------- approval detail UI */

    function ApprovalDetail(props: any) {
      const { callId, sessionId, useChat, t, grantSessionPattern, grantWorkspacePattern, allowCurrent } = props
      const command: string | undefined = useChat((snapshot: any) => {
        for (const node of snapshot.nodes.values()) {
          const root = node.kind === 'tool-call' ? node.data.root : undefined
          if (root !== undefined && root.callId === callId && !('kind' in root) && root.phase === 'start') {
            return commandOfArgs(root.argsRaw)
          }
        }
        return undefined
      })
      const [error, setError] = React.useState('')
      if (typeof command !== 'string' || command.length === 0) {
        return null
      }
      const click = async (pattern: string, toWorkspace: boolean) => {
        setError('')
        try {
          if (toWorkspace) {
            await grantWorkspacePattern(sessionId, pattern)
          } else {
            await grantSessionPattern(sessionId, pattern)
          }
          allowCurrent(sessionId, callId)
        } catch (cause: any) {
          setError(String(cause?.message ?? cause))
        }
      }
      const tiers = tiersOf(command)
      return h('div', { style: { display: 'block', marginTop: 4 } },
        h('code', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, command),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
          tiers.map(pattern => h('button', {
            key: `session:${pattern}`,
            type: 'button',
            style: tierButtonStyle,
            onClick: () => void click(pattern, false),
          }, t('allowSession', { pattern })))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
          tiers.map(pattern => h('button', {
            key: `workspace:${pattern}`,
            type: 'button',
            style: tierButtonStyle,
            onClick: () => void click(pattern, true),
          }, t('allowWorkspace', { pattern })))),
        error.length > 0
          ? h('div', { style: { marginTop: 4, color: 'var(--dsw-alias-text-danger, #c33)' } }, t('dialog.error', { message: error }))
          : null)
    }

    /* ----------------------------------------------- workspace menus/dialog */

    /**
     * Adds "Command permissions…" to the Workspace row's "…" menu. That menu
     * (rename/delete) is hardcoded in ui-workspace with no slot, so this
     * watches for its popup (a `role="menu"` portal) after a button click
     * inside a Workspace row and appends our own `role="menuitem"` row, then
     * closes the menu the way the Menu primitive's own Escape listener does.
     */
    function WorkspaceMenus({ t }: any) {
      const [dialog, setDialog] = React.useState(null)
      const tRef = React.useRef(t)
      tRef.current = t

      /** Load one workspace's lists into the dialog. */
      async function loadDialog(target: { workspaceId: string; title: string; path: string }): Promise<void> {
        setDialog({ ...target, allow: '', deny: '', error: '', busy: true })
        try {
          const payload: unknown = await runCommand(tRef.current('dialog.noSession'), `/cmdperm workspace ${target.workspaceId} list`)
          const parsed = CommandPayloadSchema.safeParse(payload)
          const allow = parsed.success ? parsed.data.allow : []
          const deny = parsed.success ? parsed.data.deny : []
          setDialog((current: any) => current !== null && current.workspaceId === target.workspaceId
            ? { ...current, allow: allow.join('\n'), deny: deny.join('\n'), busy: false }
            : current)
        } catch (cause: any) {
          setDialog((current: any) => current !== null && current.workspaceId === target.workspaceId
            ? { ...current, busy: false, error: String(cause?.message ?? cause) }
            : current)
        }
      }

      React.useEffect(() => {
        /** The workspace whose row button was clicked last, while its menu may open. */
        let pending: { workspaceId: string; title: string; path: string; at: number } | null = null

        const onClick = (event: MouseEvent) => {
          const target = event.target as Element | null
          const button = target?.closest?.('button')
          const row = button?.closest?.('[data-row-key^="workspace:"]')
          if (row == null) {
            return
          }
          // Only the "..." anchor (the row's first button) opens a menu; the
          // new-session button must not arm the injection window.
          if (row.querySelector('button') !== button) {
            return
          }
          const workspaceId = (row.getAttribute('data-row-key') ?? '').slice('workspace:'.length)
          const view = ctx.workspaces.list.getSnapshot().items
            .find((item: any) => String(item.workspaceId) === workspaceId)
          if (view === undefined) {
            return
          }
          pending = { workspaceId, title: view.title, path: view.path, at: Date.now() }
        }

        const injectItem = (popup: Element) => {
          if (pending === null || Date.now() - pending.at > 1000 || popup.querySelector('[data-cmdperm-item]') !== null) {
            return
          }
          const target = pending
          const item = document.createElement('button')
          item.type = 'button'
          item.setAttribute('role', 'menuitem')
          item.setAttribute('data-cmdperm-item', target.workspaceId)
          item.textContent = tRef.current('menu.item')
          const rows = popup.querySelectorAll('button[role="menuitem"]')
          if (rows.length > 0) {
            // Match the first row (a neutral action), never the danger row.
            item.className = rows[0].className
          } else {
            item.style.cssText = 'display:block;width:100%;text-align:left;padding:6px 10px;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer'
          }
          item.addEventListener('click', (clickEvent) => {
            clickEvent.stopPropagation()
            void loadDialog(target)
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          })
          popup.appendChild(item)
        }

        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) {
                continue
              }
              const popup = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]')
              if (popup !== null) {
                injectItem(popup)
              }
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
        // Capture phase: the "..." anchor calls stopPropagation(), so a
        // bubbling document listener would never see its clicks.
        document.addEventListener('click', onClick, true)
        return () => {
          observer.disconnect()
          document.removeEventListener('click', onClick, true)
        }
      }, [])

      const saveDialog = async () => {
        if (dialog === null) {
          return
        }
        const lists = { allow: linesOf(String(dialog.allow)), deny: linesOf(String(dialog.deny)) }
        try {
          await runCommand(t('dialog.noSession'), `/cmdperm workspace ${dialog.workspaceId} save ${JSON.stringify(lists)}`)
          setDialog(null)
        } catch (cause: any) {
          setDialog((current: any) => current === null ? current : { ...current, error: String(cause?.message ?? cause) })
        }
      }

      const nodes: any[] = []
      if (dialog !== null) {
        nodes.push(h('div', {
          key: 'dialog-backdrop',
          style: { position: 'fixed', inset: 0, zIndex: 1002, background: '#0006' },
          onMouseDown: () => {
            setDialog(null)
          },
        }))
        nodes.push(h('div', {
          key: 'dialog',
          role: 'dialog',
          'aria-modal': true,
          style: {
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1003,
            width: 'min(560px, 92vw)',
            maxHeight: '84vh',
            overflow: 'auto',
            padding: '16px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-default, #8884)',
            background: 'var(--dsw-alias-surface-raised, #fff)',
            color: 'var(--dsw-alias-text-default, inherit)',
            boxShadow: '0 8px 32px #0006',
          },
        },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, t('dialog.title', { title: dialog.title })),
          h('div', { style: { fontSize: '12px', opacity: 0.7, marginBottom: '10px', wordBreak: 'break-all' } }, dialog.path),
          h('label', { style: { display: 'block', fontSize: '12px', marginBottom: '4px' } }, t('dialog.allow')),
          h('textarea', {
            style: textareaStyle,
            value: dialog.allow,
            rows: 5,
            spellCheck: false,
            onChange: (event: any) => {
              setDialog((current: any) => ({ ...current, allow: event.target.value }))
            },
          }),
          h('label', { style: { display: 'block', fontSize: '12px', margin: '10px 0 4px' } }, t('dialog.deny')),
          h('textarea', {
            style: textareaStyle,
            value: dialog.deny,
            rows: 5,
            spellCheck: false,
            onChange: (event: any) => {
              setDialog((current: any) => ({ ...current, deny: event.target.value }))
            },
          }),
          h('div', { style: { fontSize: '11px', opacity: 0.7, marginTop: '8px' } }, t('dialog.hint')),
          dialog.error.length > 0
            ? h('div', { style: { marginTop: '6px', color: 'var(--dsw-alias-text-danger, #c33)', fontSize: '12px' } }, t('dialog.error', { message: dialog.error }))
            : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' } },
            h('button', {
              type: 'button',
              style: buttonStyle,
              onClick: () => {
                setDialog(null)
              },
            }, t('dialog.cancel')),
            h('button', {
              type: 'button',
              disabled: dialog.busy,
              style: { ...buttonStyle, background: 'var(--dsw-alias-accent-default, #247bbf)', color: '#fff', border: 'none' },
              onClick: () => void saveDialog(),
            }, t('dialog.save')))))
      }
      return h(React.Fragment, null, ...nodes)
    }

    /* --------------------------------------------------------------- wiring */

    return {
      inject: ['slots', 'remote', 'remote.commands', 'sessions', 'uiSession', 'workspaces', 'locale'],
      apply(root: any) {
        ctx = root
        root.locale.register(NS, { en, ja })

        root.slots.inject('conversation.approval.detail', () => root.slots.register({
          name: 'conversation.approval.detail',
          priority: -1,
          locale: NS,
          inject: () => ({
            grantSessionPattern: async (sessionId: string, pattern: string) => {
              await runCommand('no session', `/cmdperm session add ${pattern}`)
            },
            grantWorkspacePattern: async (sessionId: string, pattern: string) => {
              await runCommand('no session', `/cmdperm workspace allow add ${pattern}`)
            },
            allowCurrent: (sessionId: string, callId: string) => {
              const pending = root.uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction
              if (pending !== undefined && pending.kind === 'approval' && pending.callId === callId && pending.answerable) {
                void pending.answer('allowed-once')
              }
            },
          }),
        }, ApprovalDetail))

        root.slots.inject('shell.overlay', () => root.slots.register({
          name: 'shell.overlay',
          id: 'command-permission-menus',
          locale: NS,
        }, WorkspaceMenus))
      },
    }
  },
})
