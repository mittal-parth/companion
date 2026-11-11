---
name: schedules
description: Create, list, pause, resume and delete this bot's scheduled prompts with the schedule command.
---

# Schedules

Use this when the person wants something to happen at a time, on a repeat, or as a reminder. A schedule sends its prompt back into this same conversation later. It runs only while the computer is on, so do not promise it will run if the computer is off.

## Timezone first

Look in MEMORY.md for a line starting `Timezone:`. If it is there, use that IANA timezone. If it is not, ask the person for theirs (for example Asia/Kolkata) and write `Timezone: <zone>` into MEMORY.md before you create anything. Never guess a timezone.

## The prompt

The prompt is an instruction to yourself, run later with no one watching. Write it so it makes sense on its own, for example "Check the weather in Pune and tell the person if they need an umbrella."

## Commands

```
schedule create --prompt "text" --cron "0 9 * * *" --tz Asia/Kolkata
schedule create --prompt "text" --every 30m [--tz Asia/Kolkata] [--weekdays mon,fri] [--window 09:00-17:00] [--until 2026-12-31T00:00:00+05:30]
schedule create --prompt "text" --at 2026-11-12T09:00:00+05:30
schedule list
schedule pause <id>
schedule resume <id>
schedule delete <id>
```

- `--cron` is five fields: minute, hour, day of month, month, day of week. It always needs `--tz`.
- `--every` takes `30m`, `2h` or `1d`. Add `--tz` when you use `--weekdays` or `--window`. Weekdays are sun, mon, tue, wed, thu, fri, sat.
- `--at` is one instant with an offset, like `2026-11-12T09:00:00+05:30`.
- `--window` is `HH:MM-HH:MM`. The start runs and the end does not.

## After you run one

Run `schedule list` and tell the person, in plain words and in their timezone, what will run and when. Read `nextRunAt` for the next time. Use `pause <id>` when they want it off for now and `delete <id>` when they never want it. Take ids from `schedule list`.

The command prints one JSON line. When it says `"ok": false`, read `error`, fix the command and try again. Do not work around it by editing files or calling the daemon yourself.
