import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GroupStat, HookStat, Notice, RecentCall, SourceStat } from '../types'

// hook-watch: how often each hook fires and what each model-calling hook costs.
//
// Source of truth is Claude Code's own telemetry records (no exporter needed):
//   hook_execution_start/complete  -> group firings, hook counts, blocks
//   api_request_body               -> which hook made a model call (prompt hash)
//   api_response_body              -> links request_body_id to request_id
//   api_request                    -> the call's exact cost_usd
//
// Request bodies are only logged while hooks are running (the mod sets
// OTEL_LOG_RAW_API_BODIES around each hook event), are capped at 8 KB, are
// hashed on arrival, and are stripped from the record before it goes on, so no
// exporter ever receives them. Only the hash and a short label are kept.
//
// Where that is unsafe or unavailable, the mod falls back to cost per hook
// group and says so (a notice: toast once, then listed in the pane and log):
//   - the environment already sets OTEL_LOG_RAW_API_BODIES (e.g. an org's
//     telemetry): left untouched, bodies not stripped;
//   - an OpenTelemetry logs exporter is configured: body logging stays off,
//     since hook commands inherit the variable and a Claude Code they start
//     could export request text;
//   - Claude Code refuses the variable, omits query_source, has no price for
//     a model, or passes mods no hook telemetry at all.

const PANE = 'hook-watch'
const TITLE = 'Hooks'
// The docked pane's header: a mint mark, a cornflower title and a navy divider.
const MARK = '#7fd1c7'
const ACCENT = '#6c9ef8'
const DIVIDER = '#1c2a40'
const NL = String.fromCharCode(10)
const ARGS_MARK = '{"session_id"'
const LABEL_CHARS = 48

const hooksA = atom({ plugin: 'hook-watch', key: 'hooks' } as const, {}, { shape: 'hooks-1' })
const groupsA = atom({ plugin: 'hook-watch', key: 'groups' } as const, {}, { shape: 'groups-1' })
const sourcesA = atom({ plugin: 'hook-watch', key: 'sources' } as const, {}, { shape: 'sources-1' })
const recentA = atom({ plugin: 'hook-watch', key: 'recent' } as const, [], { shape: 'recent-1' })
const noticesA = atom({ plugin: 'hook-watch', key: 'notices' } as const, {}, { shape: 'notices-1' })
const ownsA = atom({ plugin: 'hook-watch', key: 'ownsBodyEnv' } as const, false, { shape: 'owns-1' })

// 'on': per-hook attribution via request bodies. Anything else: per group only.
type BodiesMode = 'on' | 'org' | 'exporter' | 'denied'
let bodiesMode: BodiesMode = 'on'
let sawHookTelemetry = false
let hookEventsThatRan = 0
const MAX_PENDING = 200

// In-flight bookkeeping (module state; a reload just drops what's pending).
type Active = { id: number; name: string; seen: Set<string> }
const active: Active[] = []
let nextGroupId = 1
type BodyInfo = { hash: string; group: string; model: string; kind: string }
const bodyById = new Map<string, BodyInfo>()
const bodyByRequest = new Map<string, string>()
const costByRequest = new Map<string, { usd: number; model: string; group: string }>()
const okByRequest = new Map<string, boolean>()
let hooksRunning = 0

// Hook titles: a settings hook's statusMessage, matched to the hash of its
// fixed prompt text (the part before $ARGUMENTS), the same hash the calls get.
let titles = new Map<string, string>()
let titlesAt = 0
type HookDef = { type?: string; prompt?: string; statusMessage?: string }
type HooksConfig = Record<string, { hooks?: HookDef[] }[] | undefined>

async function loadTitles($: EngineInterface): Promise<void> {
  titlesAt = Date.now()
  const next = new Map<string, string>()
  try {
    const config = ((await $.settings.read({ key: 'hooks' })) ?? {}) as HooksConfig
    for (const groups of Object.values(config)) {
      for (const group of groups ?? []) {
        for (const def of group.hooks ?? []) {
          if ((def.type !== 'prompt' && def.type !== 'agent') || !def.prompt || !def.statusMessage) continue
          const at = def.prompt.indexOf('$ARGUMENTS')
          const fixed = (at >= 0 ? def.prompt.slice(0, at) : def.prompt).trim()
          next.set(await sha(fixed), def.statusMessage)
        }
      }
    }
  } catch {}
  titles = next
}

async function titleOf($: EngineInterface, hash: string): Promise<string | undefined> {
  if (!titles.has(hash) && Date.now() - titlesAt > 5000) await loadTitles($)
  return titles.get(hash)
}

function nameOf(hk: HookStat | undefined): string {
  return hk ? titles.get(hk.hash) ?? hk.label : 'unknown hook'
}

function capped<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_PENDING) {
    const first = m.keys().next()
    if (first.done) break
    m.delete(first.value)
  }
}

async function notice($: EngineInterface, code: string, title: string, why: string): Promise<void> {
  const all = await read($, noticesA)
  if (all[code]) return
  const n: Notice = { code, title, why, at: Date.now() }
  await update($, noticesA, cur => ({ ...cur, [code]: n }))
  $.ui.toast(`hook-watch: ${title}. Run /hooks-log for why.`)
}

const FALLBACK = 'Model-hook cost is shown per hook group instead of per hook.'

// Decide, once per load, whether per-hook attribution is safe to switch on.
async function decideBodiesMode($: EngineInterface): Promise<void> {
  const owned = await read($, ownsA)
  const existing = await $.env.get('OTEL_LOG_RAW_API_BODIES')
  if (existing !== undefined && existing !== '' && !owned) {
    bodiesMode = 'org'
    await notice(
      $,
      'org-bodies',
      'Per-hook cost attribution is off',
      "Your environment already sets OTEL_LOG_RAW_API_BODIES, usually an organization's telemetry setup. " +
        'hook-watch leaves that setting, and the request bodies it records, untouched. ' + FALLBACK,
    )
    return
  }
  if (owned) {
    // Left on by an earlier load of this mod: switch it back off.
    await $.env.set('OTEL_LOG_RAW_API_BODIES', undefined)
    await $.env.set('CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH', undefined)
    await update($, ownsA, () => false)
  }
  const telemetry = (await $.env.get('CLAUDE_CODE_ENABLE_TELEMETRY')) ?? ''
  const logsExporter = (await $.env.get('OTEL_LOGS_EXPORTER')) ?? ''
  if (/^(1|true|yes|on)$/i.test(telemetry) && logsExporter !== '' && logsExporter !== 'none') {
    bodiesMode = 'exporter'
    await notice(
      $,
      'exporter',
      'Per-hook cost attribution is off',
      `An OpenTelemetry logs exporter is configured (OTEL_LOGS_EXPORTER=${logsExporter}). ` +
        'Per-hook attribution needs request-body logging switched on while hooks run, and hook commands would ' +
        'inherit it: a Claude Code started by a hook could then export full request text to your collector. ' +
        'hook-watch keeps body logging off. ' + FALLBACK,
    )
    return
  }
  bodiesMode = 'on'
}

async function setBodies($: EngineInterface, on: boolean): Promise<void> {
  const a = await $.env.set('CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH', on ? '8192' : undefined)
  const b = await $.env.set('OTEL_LOG_RAW_API_BODIES', on ? '1' : undefined)
  const deny = ('deny' in a && a.deny) || ('deny' in b && b.deny)
  if (on && deny) {
    bodiesMode = 'denied'
    await $.env.set('CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH', undefined)
    await $.env.set('OTEL_LOG_RAW_API_BODIES', undefined)
    await notice(
      $,
      'env-denied',
      'Per-hook cost attribution is off',
      `Claude Code refused to let hook-watch switch on request-body logging (${String(deny)}). ` + FALLBACK,
    )
    return
  }
  await update($, ownsA, () => on)
}

type Attrs = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)]
    .slice(0, 6)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// The hook's own prompt text: the first user message, up to where Claude Code
// substituted the hook input ($ARGUMENTS), which always starts {"session_id".
function promptOf(body: string): string {
  let text = ''
  try {
    const parsed = JSON.parse(body) as { messages?: { content?: unknown }[] }
    const content = parsed.messages?.[0]?.content
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      const first = content.find(c => (c as { type?: string }).type === 'text') as { text?: string } | undefined
      text = first?.text ?? ''
    }
  } catch {
    // Truncated body: fall back to the first "text" string in the raw JSON.
    const m = /"text":"((?:[^"\\]|\\.)*)/.exec(body)
    if (m?.[1]) {
      try {
        text = JSON.parse(`"${m[1]}"`) as string
      } catch {
        text = m[1]
      }
    }
  }
  const cut = text.indexOf(ARGS_MARK)
  return (cut >= 0 ? text.slice(0, cut) : text.slice(0, 2000)).trim()
}

function okOf(body: string): boolean | undefined {
  const m = /\\?"ok\\?"\s*:\s*(true|false)/.exec(body)
  return m ? m[1] === 'true' : undefined
}

const shortModel = (m: string) => m.replace(/^claude-/, '')

async function settle($: EngineInterface, requestId: string): Promise<void> {
  const bodyId = bodyByRequest.get(requestId)
  const cost = costByRequest.get(requestId)
  if (bodyId === undefined || cost === undefined) return
  const info = bodyById.get(bodyId)
  bodyByRequest.delete(requestId)
  costByRequest.delete(requestId)
  bodyById.delete(bodyId)
  const ok = okByRequest.get(requestId)
  okByRequest.delete(requestId)
  if (!info) return

  await update($, hooksA, all => {
    const h = all[info.hash]
    if (!h) return all
    return {
      ...all,
      [info.hash]: {
        ...h,
        usd: h.usd + cost.usd,
        ok: h.ok + (ok === true ? 1 : 0),
        notOk: h.notOk + (ok === false ? 1 : 0),
      },
    }
  })
  await update($, groupsA, all => {
    const g = all[info.group]
    return g ? { ...all, [info.group]: { ...g, usd: g.usd + cost.usd } } : all
  })
  const call: RecentCall = { at: Date.now(), hash: info.hash, group: info.group, model: info.model, usd: cost.usd, ok }
  await update($, recentA, l => [...l, call].slice(-100))
}

async function totals($: EngineInterface): Promise<{ fires: number; usd: number }> {
  const hooks = Object.values(await read($, hooksA))
  const groups = Object.values(await read($, groupsA))
  return { fires: groups.reduce((s, g) => s + g.fires, 0), usd: hooks.reduce((s, h) => s + h.usd, 0) }
}

function fmtUsd(usd: number): string {
  if (usd === 0) return '$0'
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(5)}`
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const SOURCE_LABEL: Record<string, string> = {
  repl_main_thread: 'conversation (main)',
  prompt_suggestion: 'prompt suggestions',
  away_summary: 'away summary',
}

function summary(
  hooks: HookStat[],
  groups: GroupStat[],
  sources: SourceStat[],
  recent: RecentCall[],
  notices: Notice[],
): string {
  const lines: string[] = []
  if (notices.length) {
    lines.push('Limitations:')
    for (const n of notices) lines.push(`  ⚠ ${n.title}`, `    ${n.why}`)
    lines.push('')
  }
  const hookUsd = hooks.reduce((s, h) => s + h.usd, 0)
  const fires = groups.reduce((s, g) => s + g.fires, 0)
  lines.push(`${fires} hook-group firings · model-calling hooks ${fmtUsd(hookUsd)}`, '')

  lines.push('Model-calling hooks (by prompt hash):')
  if (hooks.length === 0) lines.push('  none seen yet')
  for (const h of hooks.sort((a, b) => b.usd - a.usd)) {
    const where = Object.entries(h.groups)
      .map(([g, n]) => `${g}×${n}`)
      .join(', ')
    lines.push(
      `  ${nameOf(h)}  #${h.hash}`,
      `      ${h.kind} · ${shortModel(h.model)} · fired ×${h.fires} (${h.calls} calls) · ${fmtUsd(h.usd)}` +
        ` · avg ${fmtUsd(h.fires ? h.usd / h.fires : 0)}/fire · ok ${h.ok} / not ok ${h.notOk}`,
      `      in ${where}`,
    )
  }

  lines.push('', 'Hook groups:')
  for (const g of groups.sort((a, b) => b.fires - a.fires)) {
    lines.push(
      `  ${g.name.padEnd(24)} ×${String(g.fires).padEnd(5)} ${g.hooks} hook${g.hooks === 1 ? '' : 's'}` +
        `${g.modelCalls ? ` · ${g.modelCalls} model calls · ${fmtUsd(g.usd)}` : ''}` +
        `${g.unattributed ? ` (${fmtUsd(g.unattributed)} not tied to a hook)` : ''}` +
        `${g.blocking ? ` · blocked ${g.blocking}` : ''}${g.errors ? ` · errors ${g.errors}` : ''}`,
    )
  }

  if (sources.length) {
    lines.push('', 'Model calls outside hooks:')
    for (const s of sources.sort((a, b) => b.usd - a.usd)) {
      lines.push(`  ${(SOURCE_LABEL[s.source] ?? s.source).padEnd(24)} ×${String(s.calls).padEnd(5)} ${fmtUsd(s.usd)}`)
    }
  }

  if (recent.length) {
    const byHash = new Map(hooks.map(hk => [hk.hash, hk]))
    lines.push('', 'Recent model-hook calls:')
    for (const r of recent.slice(-15)) {
      const hk = byHash.get(r.hash)
      lines.push(
        `  ${time(r.at)}  ${nameOf(hk)}`,
        `      ${hk?.kind ?? 'prompt'} hook · ${r.group} · ${shortModel(r.model)} · ${fmtUsd(r.usd)}` +
          `${r.ok === undefined ? '' : r.ok ? ' · ok' : ' · NOT OK'}`,
      )
    }
  }

  return lines.join(NL)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await decideBodiesMode($)
    await loadTitles($)
    await $.command.register({
      name: 'hooks-log',
      description: 'Hook firings and cost per hook (and open the Hooks pane)',
    })
    // Earlier versions pinned a status line; the summary is a toast at each turn's end now.
    $.ui.status(undefined)

    return next(e)
  })

  // The main conversation's turn totals, taken as it starts; a subagent's turn is left out.
  let turnStart: { fires: number; usd: number } | undefined
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turnStart = await totals($)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !turnStart) return result
    const now = await totals($)
    const fired = now.fires - turnStart.fires
    const usd = now.usd - turnStart.usd
    turnStart = undefined
    if (fired > 0) $.ui.toast(`hook-watch: ${fired} hook ${fired === 1 ? 'group' : 'groups'} fired this turn · model hooks ${fmtUsd(usd)}`)
    return result
  })

  on('command.run', { command: 'hooks-log' }, async $ => {
    void $.ui.open({ id: PANE, title: TITLE })
    const [h, g, s, r, n] = await Promise.all([
      read($, hooksA),
      read($, groupsA),
      read($, sourcesA),
      read($, recentA),
      read($, noticesA),
    ])

    return { text: summary(Object.values(h), Object.values(g), Object.values(s), r, Object.values(n)) }
  })

  // Body logging only while hooks run, so main-conversation requests (~1 MB
  // each) are never serialized for this.
  on('classic.*', async ($, e, next) => {
    hooksRunning += 1
    const toggles = bodiesMode === 'on'
    if (toggles && hooksRunning === 1) {
      try {
        await setBodies($, true)
      } catch {}
    }
    const startedAt = Date.now()
    try {
      return await next(e)
    } finally {
      hooksRunning -= 1
      if (toggles && hooksRunning === 0) {
        try {
          await setBodies($, false)
        } catch {}
      }
      // Some hook ran here (it took time); telemetry should have described it.
      if (Date.now() - startedAt >= 30) hookEventsThatRan += 1
      if (hookEventsThatRan >= 3 && !sawHookTelemetry) {
        void notice(
          $,
          'no-telemetry',
          'Hook telemetry is not reaching hook-watch',
          'Hooks are running, but Claude Code is not passing its hook telemetry records to mods ' +
            '(an older Claude Code, or a setup that withholds them). Firing counts and costs cannot be shown.',
        )
      }
    }
  }).catch(($, e, next) => next(e))

  on('telemetry.log', { to: 'collector' }, async ($, e, next) => {
    const a = e.attributes as Attrs
    let forward = e
    // Bodies this mod caused never travel past it. Bodies someone else asked
    // for (an org's OTEL_LOG_RAW_API_BODIES) are left alone.
    if ('body' in a && bodiesMode === 'on') {
      const { body: _drop, ...rest } = e.attributes
      forward = { ...e, attributes: rest }
    }

    try {
      const source = str(a.query_source)
      const isHook = source.startsWith('hook_')

      switch (e.event) {
        case 'hook_execution_start': {
          sawHookTelemetry = true
          active.push({ id: nextGroupId++, name: str(a.hook_name), seen: new Set() })
          break
        }
        case 'hook_execution_complete': {
          sawHookTelemetry = true
          const name = str(a.hook_name)
          const i = active.findIndex(g => g.name === name)
          if (i >= 0) active.splice(i, 1)
          // Hook calls in this group that never got matched to a hook body.
          let loose = 0
          let looseCalls = 0
          for (const [rid, c] of costByRequest) {
            if (c.group !== name || bodyByRequest.has(rid)) continue
            loose += c.usd
            looseCalls += 1
            costByRequest.delete(rid)
          }
          if (looseCalls > 0) {
            await update($, groupsA, all => {
              const g = all[name] ?? { name, fires: 0, hooks: 0, blocking: 0, errors: 0, modelCalls: 0, usd: 0 }
              return {
                ...all,
                [name]: {
                  ...g,
                  modelCalls: g.modelCalls + looseCalls,
                  usd: g.usd + loose,
                  unattributed: (g.unattributed ?? 0) + loose,
                },
              }
            })
            if (bodiesMode === 'on') {
              await notice(
                $,
                'missing-bodies',
                'Some hook calls could not be tied to a hook',
                `A model call made by a hook in ${name} arrived without its request body, so its cost is ` +
                  'counted for the hook group, not a specific hook.',
              )
            }
          }
          const blocking = num(a.num_blocking)
          const errors = num(a.num_non_blocking_error) + num(a.num_cancelled)
          await update($, groupsA, all => {
            const g = all[name] ?? { name, fires: 0, hooks: 0, blocking: 0, errors: 0, modelCalls: 0, usd: 0 }
            return {
              ...all,
              [name]: { ...g, fires: g.fires + 1, hooks: num(a.num_hooks), blocking: g.blocking + blocking, errors: g.errors + errors },
            }
          })
          if (blocking > 0) $.ui.toast(`Hook blocked: ${name}`)
          break
        }
        case 'api_request_body': {
          if (!isHook || typeof a.body !== 'string') break
          const prompt = promptOf(a.body)
          const hash = await sha(prompt)
          void titleOf($, hash)
          const group = active.at(-1)
          const groupName = group?.name ?? 'unknown'
          const model = str(a.model)
          const firstInRun = group ? !group.seen.has(hash) : true
          group?.seen.add(hash)
          bodyById.set(str(a.request_body_id), { hash, group: groupName, model, kind: source })
          capped(bodyById)
          await update($, hooksA, all => {
            const h: HookStat = all[hash] ?? {
              hash,
              label: prompt.slice(0, LABEL_CHARS) + (prompt.length > LABEL_CHARS ? '…' : ''),
              kind: source === 'hook_agent' ? 'agent' : 'prompt',
              model,
              fires: 0,
              calls: 0,
              usd: 0,
              ok: 0,
              notOk: 0,
              groups: {},
              lastAt: 0,
            }
            return {
              ...all,
              [hash]: {
                ...h,
                model,
                calls: h.calls + 1,
                fires: h.fires + (firstInRun ? 1 : 0),
                groups: firstInRun ? { ...h.groups, [groupName]: (h.groups[groupName] ?? 0) + 1 } : h.groups,
                lastAt: Date.now(),
              },
            }
          })
          await update($, groupsA, all => {
            const g = all[groupName] ?? { name: groupName, fires: 0, hooks: 0, blocking: 0, errors: 0, modelCalls: 0, usd: 0 }
            return { ...all, [groupName]: { ...g, modelCalls: g.modelCalls + 1 } }
          })
          break
        }
        case 'api_response_body': {
          if (!isHook) break
          const requestId = str(a.request_id)
          bodyByRequest.set(requestId, str(a.request_body_id))
          capped(bodyByRequest)
          if (typeof a.body === 'string') {
            const ok = okOf(a.body)
            if (ok !== undefined) okByRequest.set(requestId, ok)
          }
          await settle($, requestId)
          break
        }
        case 'api_request': {
          const usd = num(a.cost_usd)
          const model = str(a.model)
          if (!('query_source' in a)) {
            await notice(
              $,
              'no-source',
              'Model calls are not labelled by source',
              'Claude Code is leaving query_source out of its records (a privacy setting may be on), so hook calls ' +
                'cannot be told apart from other model calls; they are all counted under "unknown".',
            )
          }
          if (usd === 0 && num(a.input_tokens) + num(a.output_tokens) > 0) {
            await notice(
              $,
              `unpriced:${model}`,
              `No price known for ${model}`,
              "Claude Code has no price for this model name (common with an LLM gateway's own model names), so " +
                'its calls show as $0. An admin can set modelPricing in managed settings to fix the figures.',
            )
          }
          if (isHook) {
            const requestId = str(a.request_id)
            costByRequest.set(requestId, { usd, model, group: active.at(-1)?.name ?? 'unknown' })
            capped(costByRequest)
            await settle($, requestId)
          } else {
            const key = source || 'unknown'
            await update($, sourcesA, all => {
              const s = all[key] ?? { source: key, calls: 0, usd: 0 }
              return { ...all, [key]: { ...s, calls: s.calls + 1, usd: s.usd + usd } }
            })
          }
          break
        }
      }
    } catch {
      // Never let the watcher get in the way of what it watches.
    }

    return next(forward)
  }).catch(($, e, next) => {
    // Still never forward a body, even when the hook above failed.
    const a = e.attributes as Attrs
    if ('body' in a && bodiesMode === 'on') {
      const { body: _drop, ...rest } = e.attributes
      return next({ ...e, attributes: rest })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const hooks = Object.values(await read($, hooksA)).sort((a, b) => b.usd - a.usd)
    const groups = Object.values(await read($, groupsA)).sort((a, b) => b.fires - a.fires)
    const sources = Object.values(await read($, sourcesA)).sort((a, b) => b.usd - a.usd)
    const recent = (await read($, recentA)).slice().reverse()
    const notices = Object.values(await read($, noticesA))
    const rows = e.viewport?.rows ?? 30

    const hookUsd = hooks.reduce((s, hk) => s + hk.usd, 0)
    const fires = groups.reduce((s, g) => s + g.fires, 0)
    const head = (t: string) => (
      <Text bold color="cyan">
        {t}
      </Text>
    )
    const cols = (cells: [string, number][], dim = false) => (
      <Box flexDirection="row">
        {cells.map(([t, w]) => (
          <Box width={w}>
            <Text dimColor={dim} wrap="truncate-end">
              {t}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const docked = e.props.placement === 'dock'
    const used = (docked ? 6 : 4) + (notices.length ? notices.length * 3 + 1 : 0) + (hooks.length * 2 + 2) + (groups.length + 2) + (sources.length ? sources.length + 2 : 0) + 2
    // Each history entry takes two rows: which hook, then where/cost/outcome.
    const recentRoom = Math.max(0, Math.floor((rows - used) / 2))
    const byHash = new Map(hooks.map(hk => [hk.hash, hk]))

    return (
      <Box flexDirection="column">
        {docked && (
          <Text bold color={ACCENT} wrap="truncate-end">
            <Text color={MARK}>◆ </Text>
            {e.props.title}
          </Text>
        )}
        {docked && <Text color={DIVIDER}>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>}
        <Text bold>
          {fires} group firings · model hooks {fmtUsd(hookUsd)}
        </Text>
        <Text dimColor>/hooks-log prints this as text</Text>
        <Button
          key="reset"
          label="Reset"
          onPress={async () => {
            await update($, hooksA, () => ({}))
            await update($, groupsA, () => ({}))
            await update($, sourcesA, () => ({}))
            await update($, noticesA, () => ({}))
            await update($, recentA, () => [])
          }}
        />

        {notices.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {notices.map(n => (
              <Box flexDirection="column">
                <Text color="yellow" bold>
                  ⚠ {n.title}
                </Text>
                <Text color="yellow" wrap="wrap">
                  {'  '}
                  {n.why}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {head('Model-calling hooks')}
          {hooks.length === 0 && <Text dimColor>none seen yet</Text>}
          {hooks.map(hk => (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                {nameOf(hk)}
              </Text>
              <Text dimColor={false} wrap="truncate-end">
                {'  '}
                <Text color="green">{fmtUsd(hk.usd)}</Text>
                {` · ×${hk.fires}${hk.calls !== hk.fires ? ` (${hk.calls} calls)` : ''} · ${shortModel(hk.model)} · ok ${hk.ok}`}
                {hk.notOk ? <Text color="red">{` · not ok ${hk.notOk}`}</Text> : ''}
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {head('Hook groups')}
          {cols([['', 22], ['fired', 8], ['hooks', 7], ['model $', 11], ['blocked', 8]], true)}
          {groups.map(g =>
            cols([
              [g.name, 22],
              [`×${g.fires}`, 8],
              [String(g.hooks), 7],
              [g.modelCalls ? fmtUsd(g.usd) + (g.unattributed ? '*' : '') : '–', 11],
              [g.blocking ? String(g.blocking) : '', 8],
            ]),
          )}
        </Box>

        {sources.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Model calls outside hooks')}
            {sources.map(s => cols([[SOURCE_LABEL[s.source] ?? s.source, 22], [`×${s.calls}`, 8], [fmtUsd(s.usd), 11]]))}
          </Box>
        )}

        {recentRoom > 0 && recent.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Recent model-hook calls')}
            {recent.slice(0, recentRoom).map(r => {
              const hk = byHash.get(r.hash)
              return (
                <Box flexDirection="column">
                  <Text wrap="truncate-end">
                    <Text dimColor>{time(r.at)} </Text>
                    <Text bold>{nameOf(hk)}</Text>
                  </Text>
                  <Text wrap="truncate-end">
                    {'  '}
                    <Text dimColor>{r.group} · {shortModel(r.model)} · </Text>
                    <Text color="green">{fmtUsd(r.usd)}</Text>
                    {r.ok === false ? <Text color="red"> · NOT OK</Text> : r.ok ? <Text dimColor> · ok</Text> : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })
}
