# Phase 3.4

The open bot's name and preset picture sit in the top center of the chat. The picture is the live avatar. Choosing that name opens a column on the right. It starts closed. The column shows the same picture, the bot's name, and that bot's schedules.

A schedule row is the prompt, a switch, the next run, and the last receipt. The switch turns the schedule off and on. Off shows Paused and no next run. There is no form, no cron field, and no computer preview. Search, plugins, and the phone layout stay out. Under each sidebar name, the latest line of that chat stays.

The browser still never talks to the daemon. The page reads and toggles schedules through Next.js routes, and those routes call the daemon. Creating and changing a schedule stays in the conversation, where the bot runs the schedule command.

```bash
pnpm test
pnpm e2e
```

`GET /bots/:id/schedules` returns that bot's schedules with `paused`, `nextRunAt`, and `lastRunAt`. An unknown bot is a 404. Another bot's schedule is a 404. POST on that path is a 405.

`POST /bots/:id/schedules/:scheduleId/pause` and `.../resume` turn one schedule off or on and return it. A paused schedule has no next run. Resume waits for the next slot.

## What the browser test covers

The schedules case starts with the column closed and the open bot's picture centered in the header. Opening it shows that picture, the name, and two schedules with their next run and an empty last receipt. The column has no text field. Turning one schedule off shows Paused and clears the next run, including on the daemon. Turning it on brings the next run back. Closing the column leaves the chat in place.
