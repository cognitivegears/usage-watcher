# usage-watcher

A Claude Code mod (`usage-buffer`) that keeps your agents from using up your whole Claude plan. It stops Claude Code before the 5-hour and weekly limits run out, so there is usage left for Claude chat and the desktop app, and it warns agents first so they can wrap up cleanly.

Requires a Claude Pro, Max or Ultra subscription (the usage figures come from the plan's rate limits) and Claude Code with mod support (v2.1.287 or later).

## Install

At the prompt of a Claude Code session:

```
/plugin install usage-buffer --marketplace cognitivegears/usage-watcher
```

Answer `y` to add the marketplace, then pick the **user** scope so it runs in every session. From a shell:

```
claude plugin install usage-buffer --marketplace cognitivegears/usage-watcher
```

## What you see

The status line shows each window as used / stop level, points left before the stop, and time to reset:

```
5h 41/90% (48.7 left, 2h10m) · wk 63/84.2% (21.2 left, 3d4h)
```

- **⚠** marks a window in the warning zone, **⛔** one at its stop level.
- In the warning zone a coloured band above the prompt repeats it and says what is happening, and a toast fires once.

## What it does

| Zone | You | Agents (including subagents) |
|---|---|---|
| Below warning | status line only | nothing |
| Warning (default: 10 points below the stop) | toast + yellow band | a note on their next tool result: finish the step, commit, write a handoff note, start nothing new; repeated every 3 more points |
| Stop | toast + red band | every tool call is refused, naming the snooze command |

**Weekly stop level slides with the days left:** it holds back 5% per day until the weekly reset, never less than 5% or more than 20%. So agents stop at 80% early in the week, 90% with 2 days left and 95% on the last day. The 5-hour window holds back a fixed 10% (stop at 90%).

If the mod itself fails, tool calls go through: a bug never blocks your work.

## Commands

| Command | Effect |
|---|---|
| `/usage-buffer` | Usage, warning and stop levels, time to reset |
| `/usage-buffer snooze [30m\|2h\|1h30m]` | Let agents continue in **every** session until it expires (default 1h) |
| `/usage-buffer resume` | End a snooze early |
| `/usage-buffer off` / `on` | Turn the guard off or on in this session only |

The snooze is kept in `~/.claude/usage-buffer/snooze.json`, so every running session sees it at once.

## Settings

Every setting is a row in `/config`; changing one reloads the mod.

| Setting | Default | Meaning |
|---|---|---|
| `weeklyReservePerDay` | 5 | % of the weekly limit held back per day until reset |
| `weeklyReserveMin` | 5 | never hold back less than this |
| `weeklyReserveMax` | 20 | never hold back more than this |
| `fiveHourReserve` | 10 | % of the 5-hour limit held back |
| `warnMargin` | 10 | points before the stop level at which warnings start |
| `warnEvery` | 3 | re-warn each agent every this many more points |
| `snoozeDefault` | `1h` | length of `/usage-buffer snooze` with no argument |

## Limits

- Usage is checked between tool calls. A model response already in progress is not cut off, so with several agents running usage can overshoot the stop level by a few points.
- The figures arrive with each response, so usage from Claude chat shows up at Claude Code's next response.
- The countdown refreshes on each tool call and each one-point move in usage, so an idle session's time-to-reset can lag.

## Development

```
claude --plugin-dir .            # run a session with the mod loaded from this folder
claude plugin validate .         # check the manifest, marketplace file and hooks module
claude plugin test .             # run hooks/*.test.ts
```

## License

MIT
