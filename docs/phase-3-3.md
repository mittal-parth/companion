# Phase 3.3

Each bot wears a preset picture: one color and one shape from the open-bot-avatar list. White is not offered. Generate and upload are not part of this. The conversation bubbles are unchanged, and there is still no search and no last-line preview.

With no bots, the page is the create screen. A color row, then a shape row, then the name. The sidebar row shows the picture being chosen and says "Create your first Bot". The header shows that picture and the name. Get started waits until the opening turn is stored, then shows the greeting. Creating another bot uses the same rows in the dialog.

A right-click on a sidebar row still offers Edit and Delete. Change avatar is the item between them. It uses the same colors and shapes. Saving it leaves the conversation as it is. The chosen picture shows in the sidebar and the header, including after a reload.

The browser still never talks to the daemon. Creating and changing the picture go through the Next.js routes, and those routes call the daemon.

```bash
pnpm test
pnpm e2e
```

`POST /bots` accepts `{ "name", "shape", "color" }`. Omitting the picture uses the blue circle. A shape or color outside the list is a 400.

`PATCH /bots/:id` with `{ "shape", "color" }` changes the stored picture and returns the bot. The name, the conversation, its folder, and a turn that is already running are left as they are. `{ "name" }` still renames, and the picture stays. An unknown bot is a 404.

## What the browser test covers

The sidebar case creates a bot from the dialog with a chosen color and shape, and that picture is in the header. After the last bot is deleted, the create screen shows the color row, the shape row, and the name, with no suggestion cards. Creating from that screen keeps the picture in the sidebar and the header. Change avatar from the row replaces it, the greeting stays, and a reload still shows the new picture.
