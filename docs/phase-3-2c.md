# Phase 3.2c

Each bot keeps the id the daemon already stored. The page puts that id in the address: `/bots/<id>`. Visiting that address opens that bot, and a refresh opens it again. Choosing a bot in the sidebar, creating one, or deleting the open one updates the address. Deleting the open bot moves to the next bot's address, or to `/` when it was the last.

`/` stays the home page. It still opens the first bot, and it does not rewrite itself to that bot's address. There is still one conversation per bot, and no search.

The browser still never talks to the daemon. The page reads the bot through the Next.js server, which calls the daemon's existing `/bots/:id`. Choosing a bot in the sidebar still uses that same read, and writes the id into the address without a second store.

```bash
pnpm test
pnpm e2e
```

## What the browser test covers

With two bots on the computer, creating one puts its id in the address. A reload of that address shows that bot, not the other one's transcript. Choosing the other bot changes the address, and a reload stays there. `/` opens the first bot. Opening the second bot's address directly shows that bot again after a reload. An unknown id says the bot is not on this computer. After the last bot is deleted, the address is `/`, and a reload stays on the create screen.
