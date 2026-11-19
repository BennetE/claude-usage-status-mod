import type { EngineInterface, Register, SessionCost, SessionRateLimit, Timer } from 'claude-code'
import { atom, memberOf, read, update } from 'claude-code'
import type { Req, Took } from '../types'

const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * 3_600_000 },
  seven_day: { label: '7d', ms: 7 * 86_400_000 },
}
const BAR_CELLS = 10
const EIGHTHS = '▏▎▍▌▋▊▉'
const GROUPS = '  │  '
const MACHINE_ORIGINS = new Set([
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel',
  'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'slack-ping', 'plugin',
])
const SETTLE_MS = 500
const NO_STOP_MS = 3000
const RECHECK_MS = 10_000
const KEEP_DURATIONS = 500
const RUNNING = new Set(['pending', 'running', 'waiting'])
// A prompt that started no turn (a local slash command) must not time a later scheduled turn.
const PENDING_TTL_MS = 60_000

const REQ = atom({ plugin: 'usage-status', key: 'req' } as const, null, { shape: 'req-v2' })
const TOOK = { plugin: 'usage-status', key: 'took' } as const

const pad = (n: number) => String(n).padStart(2, '0')

export const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${pad(s % 60)}s` : `${Math.floor(m / 60)}h${pad(m % 60)}m`
}

// Fill in eighths of a cell; `┊` sits where using the window evenly would be by now.
export const usageBar = (percentUsed: number, elapsed: number | undefined) => {
  const eighths = Math.round((Math.min(Math.max(percentUsed, 0), 100) / 100) * BAR_CELLS * 8)
  const full = Math.floor(eighths / 8)
  let bar = '█'.repeat(full) + (eighths % 8 ? EIGHTHS[(eighths % 8) - 1] : '')
  bar += '░'.repeat(BAR_CELLS - bar.length)
  if (elapsed === undefined) return bar
  const at = Math.round(Math.min(Math.max(elapsed, 0), 1) * BAR_CELLS)
  return `${bar.slice(0, at)}┊${bar.slice(at)}`
}

const WORK_WEEK_END_HOUR = 17

const mondayOf = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

const workWeekEnd = (monday: number) => {
  const d = new Date(monday)
  d.setDate(d.getDate() + 4)
  d.setHours(WORK_WEEK_END_HOUR)
  return d.getTime()
}

// Local time from Friday 17:00 to Monday 00:00.
export const isWeekend = (t: number) => t >= workWeekEnd(mondayOf(t))

const nextMonday = (monday: number) => {
  const d = new Date(monday)
  d.setDate(d.getDate() + 7)
  return d.getTime()
}

// Time between `from` and `to` that falls outside the weekend.
const workTime = (from: number, to: number) => {
  let total = 0
  for (let monday = mondayOf(from); monday < to; monday = nextMonday(monday)) {
    total += Math.max(0, Math.min(to, workWeekEnd(monday)) - Math.max(from, monday))
  }
  return total
}

// On weekdays the 7d limit is paced over its Mon–Fri time as 5d; on a worked weekend over the whole week.
export const paceOf = (limit: SessionRateLimit, now: number): { label: string; elapsed: number | undefined } => {
  const { label, ms } = WINDOWS[limit.kind]!
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (Number.isNaN(reset)) return { label, elapsed: undefined }
  if (limit.kind === 'seven_day' && !isWeekend(now)) {
    const start = reset - ms
    return { label: '5d', elapsed: workTime(start, now) / workTime(start, reset) }
  }
  return { label, elapsed: 1 - (reset - now) / ms }
}

export const formatStatus = (
  rateLimits: SessionRateLimit[],
  cost: SessionCost | undefined,
  now: number,
): string | undefined => {
  const parts: string[] = []
  const limits = rateLimits.filter(l => l.kind in WINDOWS)
  if (limits.length > 0) {
    parts.push(limits
      .map(l => {
        const { label, elapsed } = paceOf(l, now)
        return `${label} ${usageBar(l.percentUsed, elapsed)} ${Math.round(l.percentUsed)}%`
      })
      .join(' · '))
  }
  if (cost) parts.push(`$${cost.usd.toFixed(2)}`)
  return parts.length > 0 ? parts.join(GROUPS) : undefined
}

export const formatTimer = (req: Req | null, lastMs: number | undefined, now: number) => {
  if (req) return `⏱ ${fmtDuration(now - req.t0)}${req.mainOpen.length === 0 && req.tasks.length > 0 ? ' bg' : ''}`
  return lastMs === undefined ? undefined : `⏱ last ${fmtDuration(lastMs)}`
}

export const tookLabel = (t: Took) =>
  `⏱ ${t.how === 'superseded' ? '≥ ' : ''}${fmtDuration(t.ms)}` +
  (t.how === 'interrupted' ? ' (interrupted)' : t.how === 'error' ? ' (error)' : '')

const howOf = (reason: string | undefined): Took['how'] =>
  reason === 'aborted' ? 'interrupted' : reason === 'error' || reason === 'refusal' ? 'error' : 'done'

let usageText: string | undefined
let lastMs: number | undefined
let ticker: Timer | undefined
let usageTimer: Timer | undefined
let settleTimer: Timer | undefined
let pending: { t0: number; promptId?: string } | undefined
const stored = new Map<string, Took | null>()

const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {}
}

const paint = async ($: EngineInterface) => {
  const req = await read($, REQ)
  const parts = [formatTimer(req, lastMs, await $.clock.now()), usageText].filter(Boolean)
  $.ui.status(parts.length > 0 ? parts.join(GROUPS) : undefined)
}

const startTicker = ($: EngineInterface) => {
  ticker ??= $.clock.every(1000, () => void paint($))
}

const stopTicker = () => {
  ticker?.cancel()
  ticker = undefined
}

const record = async ($: EngineInterface, req: Req, end: number, how: Took['how']) => {
  const took: Took = { ms: Math.max(0, end - req.t0), how }
  const anchor = req.replyId ?? req.promptId
  lastMs = took.ms
  if (!anchor) return
  stored.set(anchor, took)
  await $.state.set({ ...TOOK, id: anchor }, took)
  await $.store.set(`t:${anchor}`, { ...took, at: end })
}

const close = async ($: EngineInterface, req: Req, end: number, how: Took['how']) => {
  let isClosed = false
  await update($, REQ, r => {
    // Only the request settle() judged: a turn or Stop that arrived meanwhile keeps it open.
    isClosed = !!r && r.t0 === req.t0 && r.mainOpen.length === 0 &&
      r.lastMainStart === req.lastMainStart && r.stopAt === req.stopAt
    return isClosed ? null : r
  })
  if (!isClosed) return
  stopTicker()
  await record($, req, end, how)
  await paint($)
}

const settle = async ($: EngineInterface) => {
  let req = await read($, REQ)
  if (!req) return
  const snap = await readStop($)
  if (snap && snap.at >= req.lastMainStart && snap.at !== req.stopAt) {
    const judged = req
    const tasks = snap.tasks === null ? judged.tasks : taskIds(snap).filter(id => !judged.baseline.includes(id))
    req = await update($, REQ, r => (r && r.t0 === judged.t0 ? { ...r, stopAt: snap.at, mainOpen: [], tasks } : r))
    if (!req || req.t0 !== judged.t0) return
  }
  if (req.mainOpen.length > 0) return
  const end = req.lastMainEnd ?? req.stopAt ?? (await $.clock.now())
  if (req.stopAt !== undefined && req.stopAt >= req.lastMainStart) {
    if (req.tasks.length === 0) await close($, req, end, howOf(req.reason))
    return
  }
  // No Stop for the last turn: give it a moment, then go by what is known to run.
  if ((await $.clock.now()) - (req.lastMainEnd ?? 0) < NO_STOP_MS) {
    scheduleSettle($, NO_STOP_MS)
    return
  }
  const running = (await $.agent.list()).filter(a => RUNNING.has(a.status)).length
  if (req.tasks.length > 0) return
  if (running > 0) scheduleSettle($, RECHECK_MS)
  else await close($, req, end, howOf(req.reason))
}

const scheduleSettle = ($: EngineInterface, ms = SETTLE_MS) => {
  settleTimer?.cancel()
  settleTimer = $.clock.after(ms, () => void settle($))
}

type StopSnapshot = { at: number; tasks: { id: string; type: string }[] | null }

// Written by hooks/stop_snapshot.py: the security guard keeps classic.Stop from hooks modules.
const readStop = async ($: EngineInterface): Promise<StopSnapshot | undefined> => {
  try {
    return JSON.parse(await $.fs.read(`${$.plugin.root}/state/stop-${await $.session.id()}.json`)) as StopSnapshot
  } catch {
    return undefined
  }
}

// A monitor can run for the whole session, so it never holds a request open.
const taskIds = (snap: StopSnapshot | undefined) =>
  (snap?.tasks ?? []).filter(t => t.type !== 'monitor').map(t => t.id)

// VS Code draws a message under its transcript row uuid with a `u` in front.
export const rowId = (requestId: string) => (/^u[0-9a-f]{8}-/.test(requestId) ? requestId.slice(1) : requestId)

const tookFor = async ($: EngineInterface, id: string): Promise<Took | undefined> => {
  const live = await read($, memberOf(TOOK, { requestId: id }))
  if (live) return live
  if (!stored.has(id)) {
    const saved = (await $.store.get(`t:${id}`)) as (Took & { at: number }) | undefined
    stored.set(id, saved ? { ms: saved.ms, how: saved.how } : null)
  }
  return stored.get(id) ?? undefined
}

const prune = async ($: EngineInterface) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith('t:'))
  if (keys.length <= KEEP_DURATIONS + 100) return
  const dated = await Promise.all(
    keys.map(async k => ({ k, at: ((await $.store.get(k)) as { at?: number } | undefined)?.at ?? 0 })),
  )
  dated.sort((a, b) => a.at - b.at)
  for (const { k } of dated.slice(0, dated.length - KEEP_DURATIONS)) await $.store.delete(k)
}

const refreshUsage = async ($: EngineInterface) => {
  const { rateLimits, cost } = await $.session.usage()
  usageText = formatStatus(rateLimits, cost, await $.clock.now())
  await paint($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      await refreshUsage($)
      // session.measure doesn't fire while idle, so the pace markers need their own tick.
      usageTimer?.cancel()
      usageTimer = $.clock.every(60_000, () => void refreshUsage($))
      if (await read($, REQ)) {
        startTicker($)
        scheduleSettle($)
      }
      void prune($)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await quietly(async () => {
      pending = undefined
      stopTicker()
      settleTimer?.cancel()
      await update($, REQ, () => null)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    usageText = formatStatus(e.rateLimits, e.cost, await $.clock.now())
    await paint($)
    return next(e)
  })

  // Recorded before next(e): the prompt's row and its turn start inside it.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = !e.isMeta && !MACHINE_ORIGINS.has(e.origin.kind)
    if (isPerson) {
      await quietly(async () => {
        const t0 = await $.clock.now()
        const req = await read($, REQ)
        const joins = e.turnId !== undefined && !!req?.mainOpen.includes(e.turnId)
        if (!joins) pending = { t0 }
      })
    }
    const result = await next(e)
    if (isPerson && result.drop !== undefined) pending = undefined
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await quietly(async () => {
        const now = await $.clock.now()
        const p = pending && now - pending.t0 < PENDING_TTL_MS ? pending : undefined
        pending = undefined
        const baseline = p ? taskIds(await readStop($)) : []
        const opened = (q: { t0: number; promptId?: string }): Req =>
          ({ t0: q.t0, mainOpen: [e.turnId], lastMainStart: now, baseline, tasks: [], promptId: q.promptId })
        let superseded: Req | undefined
        const req = await update($, REQ, r => {
          superseded = p && r && r.mainOpen.length === 0 ? r : undefined
          if (superseded) return opened(p!)
          if (r) return { ...r, mainOpen: [...r.mainOpen, e.turnId], lastMainStart: now }
          return p ? opened(p) : null
        })
        if (superseded) await record($, superseded, p!.t0, 'superseded')
        if (req) {
          startTicker($)
          await paint($)
        }
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await quietly(async () => {
        const now = await $.clock.now()
        const req = await update($, REQ, r =>
          r && { ...r, mainOpen: r.mainOpen.filter(id => id !== e.turnId), lastMainEnd: now, reason: e.reason },
        )
        if (req) {
          await paint($)
          scheduleSettle($)
        }
      })
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await quietly(async () => {
      if (e.door === 'response' && e.message.content.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')) {
        if (!(await read($, REQ))) return
        await update($, REQ, r => r && { ...r, replyId: e.uuid })
      } else if (e.door === 'prompt') {
        if (pending && !pending.promptId) pending.promptId = e.uuid
      }
    })
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.isSummary) return drawn
    const took = await tookFor($, rowId(e.requestId))
    if (!took) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Text dimColor>{tookLabel(took)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const took = await tookFor($, rowId(e.requestId))
    if (!took) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Text dimColor>{tookLabel(took)}</Text>
      </Box>
    )
  })
}
