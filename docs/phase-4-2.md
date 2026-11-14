# Phase 4.2: the base image (so far)

A user's VM needs everything a bot's computer runs. This task packages it once, so the cloud VM, a laptop and CI all run the same thing. The machine image and the CI push are not built yet. This page covers what exists.

## What the image holds

One container image, built from the `Dockerfile`, for Linux arm64 only (`docs/adr/0004-arm-images.md`).

- The daemon, run with `tsx` from the workspace layout.
- OpenCode 2.2.6 from its GitHub release, pinned by checksum.
- Xvfb, Openbox, the session and accessibility buses, Chrome, agent-browser, agent-desktop, Mousepad and Galculator, plus fonts.

The build fails if any of these is not a working arm64 binary. The container runs as a user other than root.

The image holds no secret and no per-user state. Keys arrive as environment variables when it runs, and everything the daemon keeps lives under `/data`. `.dockerignore` keeps `.env`, login state and host-built dependencies out of every layer, because the image will be public.

## Running it

`apps/daemon/src/main.ts` starts the daemon. It reads `COMPANION_DATA_DIR` (default `/data`), `PORT` (3010) and `COMPANION_HOST` (the image sets `0.0.0.0`; the default is `127.0.0.1`). `GET /health` answers once it is up.

```
docker build --target runtime -t companion-daemon .
docker run -d -e SARVAM_API_KEY -v companion-data:/data -p 127.0.0.1:3010:3010 companion-daemon
```

Publish the port on `127.0.0.1` only. On a VM nothing is published.

## Chrome's sandbox is off

Docker's default seccomp profile blocks the namespaces Chrome's sandbox needs, so Chrome would crash. The image sets `COMPANION_CHROME_SANDBOX=off`, and the daemon then starts Chrome with `--no-sandbox`. We do not use `--privileged` or `SYS_ADMIN`. The VM is the security boundary, as in the plan. A narrower seccomp profile is a later option (Task 8.3).

## Checks

- `apps/daemon/scripts/smoke-stack.ts` starts Chrome and a desktop app inside the container. `/health` alone proves nothing about them, because they start on first use.
- The `live-test` Dockerfile stage adds the test runner, `ffmpeg` and a font, so the live tests (real Sarvam turns) run inside the image. The browser, desktop, schedule, web search, vision and two-bot tests pass there.
- Replacing the container: a bot, its conversation, its files and the Chrome profile folder survive a different image on the same `/data`.

## Still to do in this task

CI build and push to GHCR by commit SHA with a secrets scan, the EC2 Image Builder stack and launch template (second volume, IMDSv2, no profile), and the `verify-image` script. How updates reach a VM is Task 4.5a.
