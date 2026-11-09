# Phase 2.3

Schedule maths answers one question: when does this prompt next go into the bot's conversation? It does not store the schedule, tick, or start a turn. The daemon does that in the tasks that follow, and the control plane will wake a stopped computer from the same instant, so both sides call this code.

A schedule is one of three kinds.

- **Cron** is a calendar time. Five fields: minute, hour, day of month, month, day of week. It carries an IANA timezone, such as `Asia/Kolkata`. "Every day at 9" is `0 9 * * *`. The 31st skips a short month. 31 February is a valid expression that never runs.
- **Interval** is real minutes from an anchor. "Every two hours" is 120 minutes, not the cron `0 */2 * * *`. Those two disagree when the clocks change. An interval can also name weekdays (0 is Sunday), a same-day window such as 09:00–17:00, and a last instant. The window's start runs; its end does not.
- **Once** is a single UTC instant. After that instant, it has no next run.

The caller passes the timezone or the instant. This code does not read the computer's zone. On a laptop the daemon will pass the computer's zone. On the cloud VM that zone stays UTC until a later task saves the person's zone.

Daylight saving follows croner. A fixed 2:30 in the spring-forward gap runs at 3:00, the first valid minute. A fixed 1:30 in the fall-back hour runs once, on the first pass. A list or a step keeps both passes of a repeated hour and skips a minute that does not exist. An interval ignores the names of those hours and keeps stepping by its real minutes.

Nothing is accepted closer than every 5 minutes. An interval's `everyMinutes` is a whole number from 5 to 1,440. A cron expression whose clock times can fall closer than that is rejected. A gap that only exists on paper, such as 31 February at 9:00 and 9:04, is allowed because it never runs.

`nextRun` returns the earliest UTC instant strictly after `now`. That instant is the occurrence. Passing it back as `now` returns the one after it, which is how a later fire can run a slot once. `nextRuns` returns the next few, for a preview.

`validateSchedule` returns the schedule or a reason a person can be shown. An empty prompt, a missing bot, a macro such as `@daily`, a six-field expression, and an unknown timezone all fail.

The functions live in `packages/shared`. The check is:

```bash
pnpm exec vitest run packages/shared/src/schedule.test.ts
```
