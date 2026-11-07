// Pure rules: no $ here, so the test can run them directly.
import type { Window } from '../types'

export type Config = {
  weeklyReservePerDay: number
  weeklyReserveMin: number
  weeklyReserveMax: number
  fiveHourReserve: number
  warnMargin: number
  warnEvery: number
  snoozeDefault: string
}
export type Verdict = { label: string; used: number; stopAt: number; warnAt: number; resetsIn?: number }

const DAY = 86_400_000
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }

export function readConfig(o: Readonly<Record<string, unknown>>): Config {
  const n = (k: string, d: number) => (typeof o[k] === 'number' ? (o[k] as number) : d)
  return {
    weeklyReservePerDay: n('weeklyReservePerDay', 5),
    weeklyReserveMin: n('weeklyReserveMin', 5),
    weeklyReserveMax: n('weeklyReserveMax', 20),
    fiveHourReserve: n('fiveHourReserve', 10),
    warnMargin: n('warnMargin', 10),
    warnEvery: Math.max(1, n('warnEvery', 3)),
    snoozeDefault: typeof o.snoozeDefault === 'string' ? o.snoozeDefault : '1h',
  }
}

/** Stop and warn levels for each live window; a window past its reset is dropped. */
export function judge(windows: readonly Window[], c: Config, now: number): Verdict[] {
  const out: Verdict[] = []
  for (const w of windows) {
    const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    if (!Number.isNaN(resets) && resets <= now) continue
    let reserve: number
    if (w.kind === 'seven_day') {
      const daysLeft = Number.isNaN(resets) ? 7 : (resets - now) / DAY
      const lo = Math.min(c.weeklyReserveMin, c.weeklyReserveMax)
      reserve = Math.min(c.weeklyReserveMax, Math.max(lo, c.weeklyReservePerDay * daysLeft))
    } else if (w.kind === 'five_hour') {
      reserve = c.fiveHourReserve
    } else continue
    const stopAt = Math.round((100 - reserve) * 10) / 10
    const v: Verdict = { label: LABEL[w.kind], used: w.percentUsed, stopAt, warnAt: Math.max(0, stopAt - c.warnMargin) }
    if (!Number.isNaN(resets)) v.resetsIn = resets - now
    out.push(v)
  }
  return out
}

/** 42m, 2h10m, 3d4h */
export function span(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return d ? `${d}d${h}h` : h ? `${h}h${mm}m` : `${mm}m`
}

const num = (n: number) => String(Math.round(n * 10) / 10)

/** "⚠ wk 72/80% (8 left, 3d4h)": used / stop level, points left to the stop, time to reset. */
export function fmt(v: Verdict): string {
  const mark = v.used >= v.stopAt ? '⛔ ' : v.used >= v.warnAt ? '⚠ ' : ''
  const left = num(Math.max(0, v.stopAt - v.used))
  const reset = v.resetsIn === undefined ? '' : `, ${span(v.resetsIn)}`
  return `${mark}${v.label} ${Math.floor(v.used)}/${num(v.stopAt)}% (${left} left${reset})`
}

/** "2h30m", "45m", "1h" or bare minutes ("90") to ms; undefined when unreadable. */
export function parseDuration(s: string): number | undefined {
  const t = s.trim()
  if (/^\d+$/.test(t)) return Number(t) * 60_000
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(t)
  if (!m || (!m[1] && !m[2])) return undefined
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
}
