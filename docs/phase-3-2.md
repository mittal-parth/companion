# Phase 3.2

The page lists every bot on this computer and opens the first one. A refresh does that again: the last bot you clicked is not remembered. Creating a bot asks for a name and stays on that dialog until the opening turn is stored, then shows the greeting. The chat header name, beside the theme control, is edited in place: click it, change the text, and leave the field or press Enter. Escape keeps the old name. There is no rename dialog. Each bot is one long conversation. There is no thread list, no search, and no last-line preview. The other pieces left out are in issue 20.

The browser still never talks to the daemon. Listing and opening go through the page. Creating and renaming go through Next.js routes, and those routes call the daemon.

```bash
pnpm test
pnpm e2e
```

`PATCH /bots/:id` with `{ "name" }` changes the stored name and returns the bot. The conversation, its folder, and a turn that is already running are left as they are. An empty name is a 400. An unknown bot is a 404.

`apps/web/src/components/bot-shell.tsx` is the sidebar and the open conversation. `apps/web/src/lib/daemon.ts` turns a daemon transcript into the messages the chat already renders. The sidebar uses the sidebar colors in `globals.css`, including the `.dark` values. The theme control stays in the chat header, beside the name.

## What the browser test covers

`e2e/chat.spec.ts` already has one bot with a transcript. The added case creates a second bot, checks that the first bot's messages are gone until that bot is chosen again, cancels a header rename with Escape, saves one by leaving the name, saves another with Enter, and reloads. The reload opens the first bot, and the new name is still in the sidebar.
