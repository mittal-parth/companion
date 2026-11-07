# Phase 0

The repo is a pnpm workspace with three packages: `@companion/web`, `@companion/daemon`, and `@companion/shared`. GitHub Actions runs `pnpm check` and `pnpm smoke` on Node 24.

The web app is a Next.js App Router skeleton with Tailwind and shadcn/ui. `/` is a placeholder page, and `/api/health` reports that the process is up. The smoke test builds the app, starts it, and requests both routes. There is no Docker image: nothing deploys this app yet, and the relay container in task 4.3 is a different service.

The daemon package is the future ACP client. It does not listen for connections yet. `@companion/shared` is the home for bot, thread, and session-update schemas. Those schemas wait for Phase 1, when a recorded OpenCode session exists to copy them from. The words are in `GLOSSARY.md`. Web and Slack being two threads of one bot is recorded in `docs/adr/0001-thread-per-channel.md`.
