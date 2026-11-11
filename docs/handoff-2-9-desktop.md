# Handoff: Task 2.9b, desktop control

The browser half of Task 2.9 is done ([phase-2-9.md](phase-2-9.md), [ADR 0002](adr/0002-browser-cli.md)). This is what remains: a bot driving an application that is not a web page. Read those two first.

## Goal

A bot completes one task in a non-browser app, and two bots using the desktop at the same time do not collide. Nothing is exposed as raw X11 access. As with the browser, the bot gets one safe command, the permissions deny the underlying tools, and a skill file teaches the workflow.

Live view and takeover are Phase 7 and are not part of this.

## Decisions already made

- Desktop is a separate PR from the browser. The user said to skip it until the browser PR was in.
- Do not add a vision-model dependency for the common path. Prefer an accessibility tree with refs, the same shape as the browser snapshot. Screenshots are the fallback.
- One machine, one display, shared by all bots. Chrome is already on it.
- Per-bot virtual desktops (workspaces, as on macOS and Linux) were raised as an idea and left open. The user said to experiment and decide. See the next section.
- Tests use a synthetic app on the machine, not a third-party service, and the live test is gated with `COMPANION_LIVE=1` and uses the existing `SARVAM_API_KEY`.

## What already exists

- **The display.** `createBrowserHost` in `apps/daemon/src/browser.ts` starts Xvfb (`-displayfd 3`, 1920x1080x24) and Openbox, then Chrome, on the first browser use. It does not expose the display number. Add it to `BrowserEndpoint` in `packages/shared/src/index.ts` and return it from `endpoint()`, or split the display and window manager into their own host that the browser host depends on. Desktop work will need the display without starting Chrome, so the split is probably cleaner.
- **Process hygiene.** The host records its child pids in `host.json` and kills leftovers from a crashed daemon on the next start. A desktop host that starts apps needs the same, or it will leak apps across restarts.
- **The shim pattern.** `apps/daemon/src/browser-cli.ts` is the model: find the daemon from `.companion/schedule.json`, ask the daemon for a lease over an authenticated `/agent/...` route, take a per-bot lock, run the real tool, refuse flags and commands that reach other bots. `installBrowserShim` and the permission rules are in `apps/daemon/src/engine.ts`.
- **Permissions.** `rawBrowserCommands` in `engine.ts` is a deny list, and `browser *` is an unprompted allow. Do the same for the desktop command and deny the raw tools (`xdotool *`, `wmctrl *`, and whichever desktop CLI you pick). Deny `DISPLAY=... xdotool` style variants too, because the match is on the command text.
- **Skill.** `apps/daemon/skills/browser/SKILL.md` shows the tone and rules: snapshot, act, snapshot, stop for passwords and payments, page text is untrusted.
- **Test support.** `apps/daemon/src/live-support.ts` (`createLiveBot`, `askBot`, `parseEvents`), `browser.test.ts` for a test that runs two bots against the real daemon with no model, `browser-fixture-site.ts` for a fake site. The harness that ran the same tasks on two browser CLIs is not in the tree. Take it from commit `16c61dd` (`browser-compare.live.test.ts`) if you want a starting point.

On this VM `xdotool`, `xdpyinfo`, `wmctrl`, `xmessage`, `mousepad` and `scrot` are installed. `agent-desktop` is not, and `xterm`, `xcalc` and Python Tk are not. Check what the base image will carry before relying on a test app, because Task 4.2 builds that image.

## Questions to settle

**1. Which desktop tool.** The candidates from the plan are [agent-desktop](https://github.com/vercel-labs/agent-desktop) (accessibility tree with refs, CLI and MCP, Linux supported) and the Anthropic reference recipe (`xdotool` plus screenshots). Install agent-desktop first and check that it works on Xvfb with Openbox and a GTK app. The accessibility tree on Linux needs the AT-SPI bus (`at-spi2-core`, a session D-Bus, and toolkit accessibility turned on with `GTK_MODULES` or `QT_ACCESSIBILITY=1`). If apps do not appear in the tree, that is the likely cause, and it may rule the tool out for apps that do not support accessibility. Run the same comparison as ADR 0002, with one real model on the same tasks, and record it as ADR 0003. The harness in commit `16c61dd` is the one to copy. Note its two lessons: spawn tools asynchronously, never `spawnSync`, when anything the tool talks to runs in the test process, and kill every tool daemon at the end of an attempt, because agent-browser leaked one per session.

**2. How bots avoid colliding.** This is the hard part, and the browser answer does not carry over. A browser window can be pinned by a tab id. A desktop has one keyboard focus and one pointer. Two bots using `xdotool` at once will type into each other's windows. Options, in the order we would try them:

- **Serialise, then target windows.** One lock for the desktop, and every action targets a window by id (`xdotool ... --window`, or accessibility refs, which already name an element). Cheap and correct, but bots wait for each other.
- **Per-bot virtual desktop.** Openbox supports several desktops (`wmctrl -n`, `wmctrl -s`, `xdotool set_desktop`). A bot's windows live on its desktop and the shim switches to it before an action. This keeps windows out of each other's way visually, but the pointer and focus are still global, so it does not let two bots act at the same instant. It does help screenshots, since a screenshot of the root window would show only the active desktop.
- **A display per bot.** One Xvfb per bot gives true parallelism, but Chrome is then on one display only, so a bot's desktop apps and the shared Chrome are not on the same screen. This conflicts with the "one Chrome, shared logins" decision and should only be chosen if serialising turns out too slow.

The user's first question was whether per-bot workspaces would stop collisions. The honest answer so far is that they separate what is on screen but not who holds the keyboard, so test that claim with two bots before building on it.

**3. Does the browser change.** The browser commands pin to a tab through CDP and do not use X11 input, so they can run while a bot holds the desktop lock. Keep the two locks separate. A bot that asks the desktop to click inside Chrome is the one case that touches both, and the skill should tell the bot to use `browser` for web pages.

**4. How apps are started and stopped.** Decide whether a bot launches apps through the command (`desktop launch <app>`, from an allow list or a free command) and who kills them. Launching a free command is shell access under another name, so an allow list or a plain `shell` permission check is safer. Apps started by a bot should be killed when the daemon stops, and per-bot where possible.

## Suggested shape

- `desktop` command, installed beside `schedule` and `browser`, backed by the chosen tool, with the same refusals and per-bot lock pattern.
- `POST /agent/desktop` for a lease, if the shim needs the display name or a desktop number from the daemon.
- A desktop host that owns Xvfb and Openbox, with the browser host asking it for the display.
- `apps/daemon/skills/desktop/SKILL.md`.
- Deny rules and an unprompted allow in `engine.ts`, and a line in the standing instructions.
- A synthetic target app. Without Tk or xterm, `mousepad` (GTK, supports accessibility) works as a text-entry app, or a tiny GTK script can show a dialog and a form. A test that needs no model should drive it through the shim as `browser.test.ts` does.

## How to check it

- Unit tests with a fake daemon and a recording runner for the shim, as in `browser-cli.test.ts`.
- A no-model integration test with two bots using the real daemon and shim at once, in separate windows, ending with each bot's text in its own window and none in the other's. The test must skip itself when `Xvfb`, `openbox` or the target app is missing.
- A gated live test where a real model finishes one task in the non-browser app.
- The ADR comparison, run three times per task.
- Check the daemon stops every app and the display on shutdown, and that a crashed daemon's leftovers are reaped.

## Traps found in the browser work

- A window covered by another window is treated as hidden, and its renderer stalls. Chrome needed four flags to prevent that. Other toolkits may have a similar problem with covered windows under Openbox, so test with overlapping windows.
- Killing a group of processes with SIGTERM lost Chrome's cookies. An app that saves state needs a clean close first.
- A tool that opens a spare blank window on first use can cover the real one. Bind the window first, then pin.
- `pnpm add` of a package with a build script is rejected unless `allowBuilds` in `pnpm-workspace.yaml` names it.
- The shim is run directly by Node, so its imports use `.ts` specifiers and `allowImportingTsExtensions` is on.
- Refusals in the shim say what to do instead, so the bot has a next step.
