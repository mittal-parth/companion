# Phase 3.2

The page lists every bot on this computer and opens the first one. A refresh does that again: the last bot you clicked is not remembered. With no bots, the page shows a screen to create one. Creating a bot asks for a name and stays on that dialog, or on that screen when the list is empty, until the opening turn is stored, then shows the greeting.

A right-click on a sidebar row offers Edit and Delete. Edit turns that row's name into a text field. Enter or leaving the field saves it, and Escape keeps the old name. The chat header shows the name and does not edit it. The theme control stays in the header, beside the name.

Delete asks for confirmation, then removes the bot and its conversation. If that bot was open, the next row opens. When the deleted row was at the end of the list, the one above it opens. The last bot leaves the create screen.

Each bot is one long conversation. There is no thread list, no search, and no last-line preview. The other pieces left out are in issue 20.

The browser still never talks to the daemon. Listing and opening go through the page. Creating, renaming, and deleting go through Next.js routes, and those routes call the daemon.

```bash
pnpm test
pnpm e2e
```

`PATCH /bots/:id` with `{ "name" }` changes the stored name and returns the bot. The conversation, its folder, and a turn that is already running are left as they are. An empty name is a 400. An unknown bot is a 404.

`DELETE /bots/:id` removes the bot, its conversation, its folder, and its schedules. A bot that is in a turn stays, and the answer is 409. An unknown bot is a 404.

`apps/web/src/components/bot-shell.tsx` is the sidebar and the open conversation. `apps/web/src/lib/daemon.ts` turns a daemon transcript into the messages the chat already renders. The sidebar uses the sidebar colors in `globals.css`, including the `.dark` values. The theme control stays in the chat header, beside the name.

## What the browser test covers

`e2e/chat.spec.ts` already has one bot with a transcript. The added case creates a second bot, checks that the first bot's messages are gone until that bot is chosen again, and renames from the row: Escape cancels, leaving the field saves, and Enter saves. The header is the name only. A reload opens the first bot, and the new name is still in the sidebar. Deleting a bot that is not open leaves the current conversation. Deleting the open bot opens the next one, and deleting the last row opens the one above it. The last bot shows the create screen, including after a reload.
