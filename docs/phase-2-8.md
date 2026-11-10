# Phase 2.8

A bot can search the web without anyone creating a search account. OpenCode already has a `websearch` tool. The daemon's `opencode.json` sets `websearch.provider` to `random` and allows that tool, so a search does not stop to ask which provider to use and does not stop for permission.

`random` keeps one provider for the session and switches when that provider returns HTTP 429. It would also pick Firecrawl and Tavily. Their free tiers were already exhausted from this network, and Firecrawl reports that as an empty result rather than a 429, so OpenCode would not switch away. Those two are denied with `websearch.use`. OpenCode's own hosted search is denied too, because that one bills the workspace at $0.01 a search. Exa, Parallel, and TinyFish remain. Each of those answered a keyless query.

The same file is written into the process config and into each bot's folder. No search key is read from the environment.

Reading a whole page is still the browser task. This task only needs the search result and a citation.

The plan's paid comparison, two providers on the same five queries and an ADR, is not done. Free search is the choice for now.

OpenCode 2.2.6 is the first version that honors `websearch.use`. Older builds ignore the denials and put Firecrawl and Tavily back in the pool. The live check uses 2.2.7. It asks for the latest stable Bun release, requires a finished web search, and requires the reply to name Bun and cite a page.

```bash
COMPANION_LIVE=1 pnpm exec vitest run apps/daemon/src/api.live.test.ts -t "free web search"
```

`opencode` must be on `PATH`, or set `OPENCODE_BIN`.
