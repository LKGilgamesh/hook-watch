/** One model-calling hook (prompt or agent), identified by a hash of its fixed prompt text. */
export type HookStat = {
  hash: string
  /** First few words of the hook's own prompt, so you can tell hooks apart. */
  label: string
  kind: string
  model: string
  /** Times the hook ran (an agent hook makes several calls per run). */
  fires: number
  calls: number
  usd: number
  ok: number
  notOk: number
  /** Hook group (e.g. "PreToolUse:Bash") -> runs there. */
  groups: Record<string, number>
  lastAt: number
}

/** One hook group as Claude Code runs it: an event plus matcher, e.g. "PreToolUse:Bash". */
export type GroupStat = {
  name: string
  fires: number
  hooks: number
  blocking: number
  errors: number
  modelCalls: number
  usd: number
  /** Model-hook cost in this group that could not be tied to a specific hook. */
  unattributed?: number
}

/** A limitation hook-watch hit: what it turned off and why. */
export type Notice = { code: string; title: string; why: string; at: number }

/** Model calls made outside any hook, by Claude Code's query source. */
export type SourceStat = { source: string; calls: number; usd: number }

export type RecentCall = {
  at: number
  hash: string
  group: string
  model: string
  usd: number
  ok?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'hook-watch': {
      hooks: Shaped<Record<string, HookStat>>
      groups: Shaped<Record<string, GroupStat>>
      sources: Shaped<Record<string, SourceStat>>
      recent: Shaped<RecentCall[]>
      notices: Shaped<Record<string, Notice>>
      ownsBodyEnv: Shaped<boolean>
    }
  }
}
