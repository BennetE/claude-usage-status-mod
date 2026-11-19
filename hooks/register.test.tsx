import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { fmtDuration, formatStatus, isWeekend, paceOf, usageBar } from './register'

const NOW = Date.parse('2026-10-27T10:34:00Z')
const LIMITS = [
  { kind: 'five_hour', percentUsed: 42.4, resetsAt: '2026-10-27T14:00:00Z' },
  { kind: 'seven_day', percentUsed: 17.6, resetsAt: '2026-10-30T09:00:00Z' },
]
const PERSON = { kind: 'composer' } as const

const row = (door: 'prompt' | 'response', uuid: string, text: string) => ({
  door,
  uuid,
  origin: door === 'prompt' ? PERSON : ({ kind: 'model', model: 'test' } as const),
  message: {
    type: door === 'prompt' ? ('user' as const) : ('assistant' as const),
    role: door === 'prompt' ? ('user' as const) : ('assistant' as const),
    content: [{ type: 'text' as const, text }],
  },
})

const done = (turnId: string, reason: 'answer' | 'aborted' = 'answer') =>
  ({ answer: '', durationMs: 0, isAborted: reason === 'aborted', turnId, reason }) as const

// As the engine does, the prompt's row is stored and its turn started inside prompt.submit's next(e).
const engine = ($: any, on: On, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  mock.session(on)
  const status: (string | undefined)[] = []
  let turn: { promptId?: string; turnId: string } | undefined
  let snapshot: string | undefined
  on('fs.read', () => (snapshot ? { value: snapshot } : { deny: 'no such file' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_, e) => {
    const t = turn
    turn = undefined
    if (t?.promptId) await $.session.append(row('prompt', t.promptId, e.text))
    if (t) await $.turn.start({ text: e.text, turnId: t.turnId })
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component}</Text>
  })
  const send = async (text: string, turnId: string, promptId?: string) => {
    turn = { turnId, promptId }
    await $.prompt.submit({ text, origin: PERSON, wait: false })
  }
  const notify = async (turnId: string) => {
    turn = { turnId }
    await $.prompt.submit({ text: '<task-notification>', origin: { kind: 'task-notification' }, wait: false })
  }
  // What hooks/stop_snapshot.py writes when the Stop hook runs.
  const stopped = (tasks: { id: string; type: string }[] = []) => {
    snapshot = JSON.stringify({ at: clock.now(), tasks })
  }
  return { clock, send, notify, stopped, last: () => status.at(-1) }
}

const lineUnder = async ($: any, component: 'AssistantMessage' | 'UserMessage', requestId: string) => {
  const props =
    component === 'AssistantMessage'
      ? { text: 'reply', isFirstOfReply: true }
      : { text: 'prompt', origin: PERSON, isExpanded: false }
  const ui = await $.ui.mount({ plugin: 'usage-status', component, requestId, surface: 'vscode', props })
  const text = (await ui.find({ type: 'Text', text: /⏱/ }))?.text
  await ui.unmount()
  return text
}

const START = { cwd: '/', surface: 'vscode', isInteractive: true } as const

test('formats both limits with bars and pace markers, then the cost', () => {
  expect(formatStatus(LIMITS, { usd: 2.4 }, NOW)).toBe('5h ███┊█▎░░░░░ 42% · 5d █▊░░┊░░░░░░ 18%  │  $2.40')
  expect(formatStatus([{ kind: 'five_hour', percentUsed: 3 }], undefined, NOW)).toBe('5h ▎░░░░░░░░░ 3%')
  expect(formatStatus([], undefined, NOW)).toBe(undefined)
})

test('fills the bar in eighths and marks the pace', () => {
  expect(usageBar(10, 0.6)).toBe('█░░░░░┊░░░░')
  expect(usageBar(42, 0.6)).toBe('████▎░┊░░░░')
  expect(usageBar(75, 0.6)).toBe('██████┊█▌░░')
  expect(usageBar(97, 0.6)).toBe('██████┊███▊')
  expect(usageBar(130, 1.2)).toBe('██████████┊')
})

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const week = (resetsAt: number, now: number) =>
  paceOf({ kind: 'seven_day', percentUsed: 30, resetsAt: new Date(resetsAt).toISOString() }, now)
const WED_NOON = at(2026, 11, 11, 12)

test('a weekend reset paces the 7d limit over Mon 00:00 to Fri 17:00', () => {
  expect(week(at(2026, 11, 14, 10), WED_NOON)).toEqual({ label: '5d', elapsed: 60 / 113 })
  expect(week(at(2026, 11, 15, 20), at(2026, 11, 9))).toEqual({ label: '5d', elapsed: 0 })
  expect(week(at(2026, 11, 13, 17), WED_NOON)).toEqual({ label: '5d', elapsed: 60 / 113 })
  expect(week(at(2026, 3, 29, 12), at(2026, 3, 25, 12))).toEqual({ label: '5d', elapsed: 60 / 113 })
  expect(formatStatus([{ kind: 'seven_day', percentUsed: 30, resetsAt: new Date(at(2026, 11, 14, 10)).toISOString() }],
    undefined, WED_NOON)).toBe('5d ███░░┊░░░░░ 30%')
})

test('a midweek reset paces over its Mon–Fri time, the past and the coming weekend left out', () => {
  expect(week(at(2026, 11, 13, 16, 59), WED_NOON)).toEqual({ label: '5d', elapsed: (60 + 1 / 60) / 113 })
  expect(week(at(2026, 11, 11, 18), at(2026, 11, 9, 8))).toEqual({ label: '5d', elapsed: (47 + 8) / 113 })
  expect(week(at(2026, 11, 11, 18), at(2026, 11, 6, 16))).toEqual({ label: '5d', elapsed: 46 / 113 })
  expect(week(at(2026, 4, 3, 17, 30), at(2026, 3, 27, 16, 45))).toEqual({ label: '5d', elapsed: 0.25 / 113.5 })
  expect(formatStatus([{ kind: 'seven_day', percentUsed: 30, resetsAt: new Date(at(2026, 11, 4, 18)).toISOString() }],
    undefined, WED_NOON)).toBe('5d ███░░░░░░░┊ 30%')
})

test('a worked weekend shows the calendar 7d pace', () => {
  expect(week(at(2026, 11, 14, 10), at(2026, 11, 14, 9))).toEqual({ label: '7d', elapsed: 1 - 1 / 168 })
  expect(week(at(2026, 11, 14, 10), at(2026, 11, 13, 17))).toEqual({ label: '7d', elapsed: 1 - 17 / 168 })
  expect(week(at(2026, 11, 11, 18), at(2026, 11, 7, 12))).toEqual({ label: '7d', elapsed: 1 - (4 * 24 + 6) / 168 })
})

test('the weekend runs from Friday 17:00 to Monday 00:00', () => {
  expect(isWeekend(at(2026, 11, 13, 16, 59))).toBe(false)
  expect(isWeekend(at(2026, 11, 13, 17))).toBe(true)
  expect(isWeekend(at(2026, 11, 15, 23, 59))).toBe(true)
  expect(isWeekend(at(2026, 11, 16))).toBe(false)
})

test('formats durations', () => {
  expect(fmtDuration(42_000)).toBe('42s')
  expect(fmtDuration(252_000)).toBe('4m12s')
  expect(fmtDuration(3_780_000)).toBe('1h03m')
})

test('a request is timed until its background agent has finished', async ($, on) => {
  const { clock, send, notify, stopped, last } = engine($, on)
  await $.session.start(START)

  await send('go', 't1', 'p1')
  await clock.advance(65_000)
  expect(last()).toMatch(/^⏱ 1m05s/)

  await $.session.append(row('response', 'm1', 'started an agent'))
  await $.turn.complete(done('t1'))
  stopped([{ id: 'a1', type: 'subagent' }])
  await clock.advance(10_000)
  expect(last()).toMatch(/^⏱ 1m15s bg/)

  await notify('t2')
  await $.session.append(row('response', 'm2', 'the agent is done'))
  await $.turn.complete(done('t2'))
  stopped()
  await clock.advance(1_000)

  expect(last()).toMatch(/^⏱ last 1m15s/)
  expect(await lineUnder($, 'AssistantMessage', 'm2')).toBe('⏱ 1m15s')
  expect(await lineUnder($, 'AssistantMessage', 'm1')).toBe(undefined)
})

test('background work that ran before the request does not hold it open', async ($, on) => {
  const { clock, send, stopped } = engine($, on)
  await $.session.start(START)
  stopped([{ id: 'dev-server', type: 'shell' }])

  await send('go', 't1')
  await clock.advance(8_000)
  await $.session.append(row('response', 'm1', 'done'))
  await $.turn.complete(done('t1'))
  stopped([{ id: 'dev-server', type: 'shell' }])
  await clock.advance(1_000)

  expect(await lineUnder($, 'AssistantMessage', 'm1')).toBe('⏱ 8s')
})

test('an interrupt with no Stop closes on the fallback, under the prompt', async ($, on) => {
  const { clock, send } = engine($, on)
  await $.session.start(START)

  await send('go', 't1', 'p1')
  await clock.advance(5_000)
  await $.turn.complete(done('t1', 'aborted'))
  await clock.advance(1_000)
  expect(await lineUnder($, 'UserMessage', 'p1')).toBe(undefined)

  await clock.advance(5_000)
  expect(await lineUnder($, 'UserMessage', 'p1')).toBe('⏱ 5s (interrupted)')
})

test('a new prompt while background work runs closes the request as a lower bound', async ($, on) => {
  const { clock, send, stopped, last } = engine($, on)
  await $.session.start(START)

  await send('go', 't1')
  await $.session.append(row('response', 'm1', 'started a workflow'))
  await clock.advance(20_000)
  await $.turn.complete(done('t1'))
  stopped([{ id: 'w1', type: 'workflow' }])
  await clock.advance(40_000)

  await send('next', 't2')
  expect(await lineUnder($, 'AssistantMessage', 'm1')).toBe('⏱ ≥ 1m00s')
  await clock.advance(3_000)
  expect(last()).toMatch(/^⏱ 3s/)
})

test('a hidden delivery does not supersede a request waiting on background work', async ($, on) => {
  const { clock, send, stopped, last } = engine($, on)
  await $.session.start(START)

  await send('go', 't1')
  await $.turn.complete(done('t1'))
  stopped([{ id: 'a1', type: 'subagent' }])
  await $.prompt.submit({ text: 'receipt', origin: { kind: 'unclassified' }, isMeta: true, wait: false })
  await clock.advance(2_000)

  expect(last()).toMatch(/^⏱ 2s bg/)
})

test('VS Code draws a reply under its row uuid with a u in front', async ($, on) => {
  const { clock, send, stopped } = engine($, on)
  await $.session.start(START)

  await send('go', 't1')
  await clock.advance(4_000)
  await $.session.append(row('response', '2dc80100-287d-4503-b9cf-96deca1b8129', 'ok'))
  await $.turn.complete(done('t1'))
  stopped()
  await clock.advance(1_000)

  expect(await lineUnder($, 'AssistantMessage', 'u2dc80100-287d-4503-b9cf-96deca1b8129')).toBe('⏱ 4s')
})

test('a duration an earlier session stored is drawn', async ($, on) => {
  engine($, on, { 't:old': { ms: 252_000, how: 'done', at: NOW } })
  expect(await lineUnder($, 'AssistantMessage', 'old')).toBe('⏱ 4m12s')
})
