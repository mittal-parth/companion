# agent-desktop drives the bots' desktop

**Decision:** agent-desktop is the desktop CLI and the only one the daemon depends on. `xdotool` and `scrot` are not dependencies, and the bot's permissions deny them.

Bots drive applications that are not web pages with [agent-desktop](https://github.com/vercel-labs/agent-desktop) (1.2.0), behind our own `desktop` command. `xdotool` plus a screenshot, read by the vision subagent, was the other candidate. agent-desktop gives the model a text snapshot with element refs, so the common path needs no vision model. The screenshot path does.

The deciding factor is how each tool behaves when several bots share one screen. agent-desktop can pin a command to a window and act on a ref without moving the pointer. `xdotool` types into whichever window is in front, and a screenshot is the only way to see the result. It also took about five times as many tool calls and about four times as long.

## What was compared

The same bot, model (`glm5.3`), windows and wording, with only the tool changed. Each tool ran each task three times on a fresh Xvfb, Openbox and accessibility bus. The windows were already open, so the bot could not satisfy the task by writing the answer file itself.

- **form:** a GTK form titled Companion form. Enter the name Priya Nair, accept the terms, submit, and reply with the confirmation code. Submit does nothing useful until the terms are accepted. The run fails unless the form's own result file has that name and the reply contains the code the form wrote.
- **note:** a Mousepad window opened on an empty file. Type the sentence `The oak code is 4419.` into the editor, without a file tool or the shell, and reply with the sentence. The run fails unless a later accessibility snapshot of that window contains the sentence and the reply contains 4419.

All 12 runs passed. Tool calls, context size (the largest context the model reported) and wall time are means over three runs.

| Task | Tool          | Tool calls | Context tokens | Seconds |
| ---- | ------------- | ---------- | -------------- | ------- |
| form | agent-desktop | 7.7        | 12,408         | 36      |
| form | xdotool       | 37.3       | 16,119         | 162     |
| note | agent-desktop | 6.0        | 26,372         | 37      |
| note | xdotool       | 31.7       | 15,405         | 152     |
| all  | agent-desktop | 6.8        | 19,390         | 37      |
| all  | xdotool       | 34.5       | 15,762         | 157     |

`xdotool` used about five times as many calls and about four times as many seconds. Context is mixed. On the form, agent-desktop used less (a spread of 10,176 to 16,603, against 11,479 to 21,218). On the note, it used more (23,625 to 27,930, against 10,694 to 20,435), because Mousepad's accessibility tree includes the whole menu. A screenshot never enters the text model's context. That is a real cost of the snapshot, and it is still the cheaper task in time: the slowest agent-desktop run was 46 seconds, and the fastest `xdotool` run was 82 seconds and 19 calls.

One snapshot of the empty form, and a screenshot of the same window:

| View                        | Size        |
| --------------------------- | ----------- |
| agent-desktop `snapshot -i` | 666 chars   |
| screenshot of the same form | 8,042 bytes |

The screenshot is small as a file and useless to the text model until the vision subagent has described it, which costs a call and a round trip. The form snapshot is short enough to act on directly.

Several `xdotool` runs saved the PNG outside the bot's folder. The read was denied, and the model spent calls recovering before it asked the vision subagent with a path inside the folder. The product's `desktop screenshot` does not do that: it writes the PNG inside the bot's folder and tells the bot to ask the vision subagent. Part of the call gap is that recovery. The gap remains after setting it aside, because the cheapest `xdotool` run was still well above every agent-desktop run.

## Why agent-desktop

We run one screen for every bot, shared with Chrome (see [phase-2-9b.md](../phase-2-9b.md)). Two bots have to be able to work at the same moment without typing into each other's window.

agent-desktop binds a session to the bot and accepts `--window-id` on snapshot, screenshot, press and focus. A ref such as `click @e3` names an element in that bot's snapshot and does not move the pointer. Our `desktop` command uses that, and holds one lock for the whole screen because a key, a raise and a covered-window screenshot are still global.

`xdotool` has no element ref. The model has to see the screen, so every check goes through the vision subagent, and a key reaches whichever window is focused. A wrapper could raise the right window first, and our shim does that for screenshot and press, but two commands arriving together would still race on the one keyboard.

Other points that favoured agent-desktop:

- `skills get desktop` prints the workflow the bot needs, so the bot learns it on demand.
- It is a native binary, so a command does not start Node, which matters when a bot makes several calls per task.
- Its blocked-by-us surface is the flags and commands that would move the shared pointer or escape the bot's windows: `--headed`, `--session`, `--screen`, the clipboard, and the mouse commands.

What it costs us:

- The snapshot of a large GTK app includes menus the bot did not ask about. The note task spent about 26,000 context tokens on a one-line edit.
- The install script has to be allowed to run, or the package falls back to a Node launcher.
- It is a young tool. We pin the version and rely on the shim as the only entry point, so swapping tools later means changing one file and the skill.

## When to revisit

`xdotool` plus the vision subagent is the better fit if the main model can already see, or if a snapshot of a real application grows past the point where the extra context costs more than the extra calls. The harness is `apps/daemon/tests/desktop-compare.live.test.ts`. It is skipped unless `COMPANION_COMPARE=1`. `COMPARE_RUNS`, `COMPARE_TOOLS` and `COMPARE_TASKS` narrow it, and `COMPARE_OUT` names the JSON file.
