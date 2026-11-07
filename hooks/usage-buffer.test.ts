import { expect, test } from 'claude-code/testing'

import { fmt, judge, parseDuration, readConfig, span } from './policy'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-07T12:00:00Z')
const cfg = readConfig({})
const at = (days: number) => new Date(NOW + days * DAY).toISOString()

test('weekly stop level slides with days left, within min and max', async () => {
  const stop = (days: number) =>
    judge([{ kind: 'seven_day', percentUsed: 0, resetsAt: at(days) }], cfg, NOW)[0].stopAt
  expect(stop(7)).toBe(80) // 35% capped at the 20% max
  expect(stop(4)).toBe(80)
  expect(stop(2)).toBe(90)
  expect(stop(0.5)).toBe(95) // 2.5% raised to the 5% min
  expect(judge([{ kind: 'five_hour', percentUsed: 0, resetsAt: at(0.1) }], cfg, NOW)[0]).toEqual({
    label: '5h', used: 0, stopAt: 90, warnAt: 80, resetsIn: 0.1 * DAY,
  })
  // A window past its reset no longer counts.
  expect(judge([{ kind: 'seven_day', percentUsed: 99, resetsAt: at(-0.01) }], cfg, NOW)).toEqual([])
})

test('settings override the defaults', async () => {
  const c = readConfig({ weeklyReservePerDay: 3, weeklyReserveMax: 30, weeklyReserveMin: 0, warnMargin: 5 })
  const v = judge([{ kind: 'seven_day', percentUsed: 0, resetsAt: at(7) }], c, NOW)[0]
  expect(v.stopAt).toBe(79)
  expect(v.warnAt).toBe(74)
})

test('status text shows used/stop, points left and time to reset', async () => {
  const line = (kind: string, used: number, days: number) =>
    fmt(judge([{ kind, percentUsed: used, resetsAt: at(days) }], cfg, NOW)[0])
  expect(line('five_hour', 41.3, 130 / 1440)).toBe('5h 41/90% (48.7 left, 2h10m)')
  expect(line('seven_day', 63, 3 + 4 / 24)).toBe('wk 63/84.2% (21.2 left, 3d4h)')
  expect(line('seven_day', 72, 5)).toBe('⚠ wk 72/80% (8 left, 5d0h)')
  expect(line('seven_day', 85, 2)).toBe('⚠ wk 85/90% (5 left, 2d0h)')
  expect(line('seven_day', 91, 2)).toBe('⛔ wk 91/90% (0 left, 2d0h)')
  expect(span(42 * 60_000)).toBe('42m')
})

test('durations parse', async () => {
  expect(parseDuration('30m')).toBe(30 * 60_000)
  expect(parseDuration('2h')).toBe(2 * 3_600_000)
  expect(parseDuration('1h30m')).toBe(90 * 60_000)
  expect(parseDuration('45')).toBe(45 * 60_000)
  expect(parseDuration('soon')).toBe(undefined)
})

function engine(on: any, snooze?: number) {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.read', () => (snooze === undefined ? { deny: 'ENOENT' } : { value: JSON.stringify({ until: snooze }) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {} }))
}

const measure = (fiveHour: number, weekly: number) => ({
  context: { window: 200_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: at(0.1) },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: at(4) },
  ],
  changed: ['rateLimits'],
})

test('tool calls pass under the warn level', async ($: any, on: any) => {
  engine(on)
  await $.session.measure(measure(50, 50))
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.deny).toBe(undefined)
  expect(r.context ?? []).toEqual([])
})

test('in the warning zone the agent gets a wrap-up note', async ($: any, on: any) => {
  engine(on)
  await $.session.measure(measure(50, 72)) // weekly: warn 70, stop 80
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.deny).toBe(undefined)
  expect(String(r.context?.[0])).toMatch(/handoff/)
  // Not repeated until usage climbs warnEvery more points.
  const again = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(again.context ?? []).toEqual([])
})

test('past the stop level tool calls are refused, unless snoozed', async ($: any, on: any) => {
  engine(on)
  await $.session.measure(measure(91, 10))
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(String(r.deny ?? r.text)).toMatch(/snooze/)
})

test('a snooze lets tool calls through', async ($: any, on: any) => {
  engine(on, NOW + 3_600_000)
  await $.session.measure(measure(91, 10))
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.deny).toBe(undefined)
  expect(r.isError ?? false).toBe(false)
})
