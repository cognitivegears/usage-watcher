import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Window } from '../types'
import { type Config, fmt, judge, parseDuration, readConfig, span, type Verdict } from './policy'

const limits = atom({ plugin: 'usage-buffer', key: 'limits' } as const, [] as Window[])
const isOff = atom({ plugin: 'usage-buffer', key: 'isOff' } as const, false)
const snoozeUntil = atom({ plugin: 'usage-buffer', key: 'snoozeUntil' } as const, 0)

type Zone = 'ok' | 'warn' | 'stop'
const RANK: Record<Zone, number> = { ok: 0, warn: 1, stop: 2 }

// The snooze lives in a file, not $.store: every running session must see it at once.
async function snoozePath($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? ''}/.claude/usage-buffer/snooze.json`
}

async function readSnooze($: EngineInterface): Promise<number> {
  try {
    const j = JSON.parse(await $.fs.read(await snoozePath($)))
    return typeof j.until === 'number' ? j.until : 0
  } catch {
    return 0 // no file: not snoozed
  }
}

const zoneOf = (vs: Verdict[]): Zone =>
  vs.some(v => v.used >= v.stopAt) ? 'stop' : vs.some(v => v.used >= v.warnAt) ? 'warn' : 'ok'

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// Module variables start over on a reload; that only re-sends a warning.
const told = new Map<string, number>() // agent id -> usage % it was last warned at
let lastZone: Zone = 'ok'

async function snapshot($: EngineInterface, cfg: Config) {
  const now = await $.clock.now()
  const until = await readSnooze($)
  await update($, snoozeUntil, () => until)
  const vs = judge(await read($, limits), cfg, now)
  const s = { now, vs, zone: zoneOf(vs), isSnoozed: until > now, until, isOff: await read($, isOff) }
  // Refreshed on every snapshot (each tool call too) so the reset countdown stays current.
  const extra = s.isOff ? ' · guard off' : s.isSnoozed ? ` · snoozed till ${clock(until)}` : ''
  $.ui.status(vs.length ? vs.map(fmt).join(' · ') + extra : undefined)
  return s
}

async function refresh($: EngineInterface, cfg: Config, windows?: readonly Window[]) {
  if (windows) await update($, limits, () => [...windows])
  const s = await snapshot($, cfg)
  if (RANK[s.zone] > RANK[lastZone] && !s.isOff && !s.isSnoozed) {
    const what = s.vs.map(fmt).join(', ')
    $.ui.toast(
      s.zone === 'stop'
        ? `Usage buffer reached: ${what}. Agents are stopped; /usage-buffer snooze to continue.`
        : `Usage nearing the buffer: ${what}. Agents are told to wrap up.`,
    )
  }
  lastZone = s.zone
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-buffer',
      description: 'Usage buffer: status | snooze [30m|2h] | resume | off | on',
    })
    const u = await $.session.usage()
    await refresh($, cfg, u.rateLimits)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await refresh($, cfg, e.rateLimits)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const s = await snapshot($, cfg)
    if (s.isOff || s.isSnoozed || s.zone === 'ok') return next(e)

    const what = s.vs.map(fmt).join(', ')
    if (s.zone === 'stop') {
      return {
        deny:
          `Usage buffer reached (${what}); the rest is reserved for Claude chat. ` +
          `Stop work now. The person can run /usage-buffer snooze to let agents continue.`,
      }
    }

    const ran = await next(e)
    // Warn each agent once on entering the zone, then again every warnEvery points.
    const agent = 'agentId' in e && typeof e.agentId === 'string' ? e.agentId : 'main'
    const peak = Math.max(...s.vs.map(v => v.used))
    const last = told.get(agent)
    if (ran.deny !== undefined || (last !== undefined && peak < last + cfg.warnEvery)) return ran
    told.set(agent, peak)
    const note =
      `Plan usage is nearing the reserved buffer: ${what}. Agents will be stopped at that level. ` +
      `Finish the current step, commit or save your work, and write a short handoff note ` +
      `(what is done, what is not, the exact next step). Do not start new work.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e)) // a guard bug must not block work: fail open

  on('command.run', { command: 'usage-buffer' }, async ($, e) => {
    const [verb = 'status', arg = ''] = e.args.trim().split(/\s+/).filter(Boolean)
    const path = await snoozePath($)
    const now = await $.clock.now()

    if (verb === 'snooze') {
      const ms = parseDuration(arg || cfg.snoozeDefault)
      if (!ms) return { text: `Can't read "${arg}". Try 30m, 2h or 1h30m.` }
      await $.fs.write(path, JSON.stringify({ until: now + ms }))
      await refresh($, cfg)
      return { text: `Snoozed for every session until ${clock(now + ms)}.` }
    }
    if (verb === 'resume') {
      await $.fs.write(path, JSON.stringify({ until: 0 }))
      await refresh($, cfg)
      return { text: 'Snooze cleared; the buffer applies again in every session.' }
    }
    if (verb === 'off' || verb === 'on') {
      await update($, isOff, () => verb === 'off')
      return { text: verb === 'off' ? 'Guard off for this session only.' : 'Guard back on for this session.' }
    }

    const s = await snapshot($, cfg)
    const lines = s.vs.length
      ? s.vs.map(
          v =>
            `${v.label === 'wk' ? 'Weekly' : '5-hour'}: ${v.used}% used · ${Math.max(0, Math.round((v.stopAt - v.used) * 10) / 10)} points ` +
            `left before agents stop at ${v.stopAt}% (warnings from ${v.warnAt}%)` +
            (v.resetsIn === undefined ? '' : ` · resets in ${span(v.resetsIn)}`),
        )
      : ['No usage reading yet (it arrives after the first response).']
    if (s.isSnoozed) lines.push(`Snoozed until ${clock(s.until)}.`)
    if (s.isOff) lines.push('Guard is off in this session.')
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const vs = judge(await read($, limits), cfg, now)
    const zone = zoneOf(vs)
    const off = await read($, isOff)
    const until = await read($, snoozeUntil)
    if (zone === 'ok' && !off && until <= now) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const what = vs.map(fmt).join(' · ')
    const tail = off
      ? ' — guard OFF in this session'
      : until > now
        ? ` — snoozed until ${clock(until)}`
        : zone === 'stop'
          ? ' — agents stopped; /usage-buffer snooze to continue'
          : ' — agents told to wrap up'
    return (
      <Box>
        <Text color={zone === 'stop' ? 'red' : 'yellow'}>{what}{tail}</Text>
      </Box>
    )
  })
}
