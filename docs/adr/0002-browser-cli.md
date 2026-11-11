# agent-browser drives the bots' browser

Bots drive the shared Chrome with [agent-browser](https://github.com/vercel-labs/agent-browser) (0.42.0), behind our own `browser` command. [Playwright CLI](https://playwright.dev/agent-cli/introduction) (`@playwright/cli` 0.1.24) was the other candidate. Both give the model a text snapshot with element refs, so neither needs a vision model.

Cost per task is close. The deciding factor is how each tool behaves when several bots share one Chrome, and only agent-browser can keep each bot on its own window.

## What was compared

The same bot, model (`glm5.3`), prompt wording, and fake site, with only the tool's name and how it attaches to Chrome changed. Each tool ran each task three times against the same shared Chrome.

- **booking:** search, open the second result, book it through a form that rejects the first submit until the terms are accepted, and report the confirmation code.
- **awkward:** a page with a link that opens a new tab, an iframe, a dialog, and an element that appears late.
- **login:** sign in, stop and restart the daemon and Chrome on the same profile, then read the account page without signing in again. The run fails if the site saw a second sign-in.

A run passes only when the reply contains every code the page produced, so a made-up answer fails. All 18 runs passed. Tool calls, context size (the largest context the model reported) and wall time are means over three runs.

| Task    | Tool           | Tool calls | Context tokens | Seconds |
| ------- | -------------- | ---------- | -------------- | ------- |
| booking | agent-browser  | 15.7       | 11,962         | 51      |
| booking | Playwright CLI | 14.0       | 10,422         | 47      |
| awkward | agent-browser  | 21.3       | 13,662         | 86      |
| awkward | Playwright CLI | 16.0       | 12,863         | 65      |
| login   | agent-browser  | 9.3        | 15,917         | 44      |
| login   | Playwright CLI | 11.3       | 11,452         | 48      |
| all     | agent-browser  | 15.4       | 13,847         | 61      |
| all     | Playwright CLI | 13.8       | 11,579         | 53      |

Playwright CLI was about 10% cheaper in calls, 16% in context and 13% in time. With three runs per cell and a spread of 9 to 26 calls for one task, that is a small edge, not a clear win. These numbers come from one model on three synthetic tasks.

One snapshot of a fixture page, in characters:

| Page         | agent-browser `snapshot -i` | Playwright CLI `snapshot` |
| ------------ | --------------------------- | ------------------------- |
| form page    | 518                         | 1,924                     |
| awkward page | 228                         | 1,218                     |

agent-browser's interactive-only snapshot is smaller, but the two commands do not ask for the same thing. Playwright's includes non-interactive text, and its snapshot is written to a file that the model then reads, which costs an extra call. That is probably why Playwright took fewer calls overall yet used more context on the login task. On a large real page the gap in agent-browser's favour would be larger.

## Why agent-browser

We run one Chrome and one profile for every bot (see [phase-2-9.md](../phase-2-9.md)). Two bots have to be able to work at the same moment without touching each other's page.

agent-browser can bind a session to one tab and pin every later command to it (`tab <id>`, then `--pin-tab`). Our `browser` command uses that to keep each bot on its own window.

Playwright CLI has no such pin. We attached two sessions to the same Chrome, each after the daemon had opened a window for it. Session `b` went to `/items/2`, and session `a`, which had just gone to `/items/1`, then reported being on `/items/2`. Both sessions showed the same tab list with tab 0 as current. One bot's navigation moved the other bot's page. The booking and awkward runs above never saw this because they ran one bot at a time. A wrapper could re-select a tab before every command, but the selection is shared browser state, so two commands arriving together would still race.

Other points that favoured agent-browser:

- `--cdp <port>` attaches to a Chrome we already run, and its `skills get core` prints the workflow the bot needs, so the bot learns it on demand.
- It is a native binary, so a command does not start Node, which matters when a bot makes 15 to 25 calls per task.
- Its blocked-by-us surface is small: the flags that could reroute a command are `--session`, `--cdp`, `--profile` and a few more, and the shim refuses them.

What it costs us:

- Our shim has to open the window itself. agent-browser's own `window new` creates an isolated context with its own cookies, which would break shared logins.
- It had gaps the model hit more often: `text=` selectors are not supported, so the fixture tasks use CSS selectors and `wait --text`.
- It is a young tool (0.x). We pin the version and rely on the shim as the only entry point, so swapping tools later means changing one file and the skill.

## When to revisit

Playwright CLI is the better fit for a single bot on its own browser, where its smaller cost per task is real and Firefox or WebKit may matter. If it gains a per-session tab pin, or if we give each bot its own Chrome (which breaks shared logins unless profiles are copied), this choice should be looked at again. The comparison can be re-run with the command in [phase-2-9.md](../phase-2-9.md).
