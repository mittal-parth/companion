# Phase 4.2: the base image

A user's VM needs everything a bot's computer runs. This task packages it once, so the cloud VM, a laptop and CI all run the same thing. It has two parts: a container image with everything we ship, and a thin machine image (AMI) that runs it.

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

## CI builds and publishes the container image

The `image` job in `.github/workflows/ci.yml` runs on an arm64 runner. It builds the image, starts it and runs the stack smoke check, scans it for secrets with Trivy, and, for pushes and same-repository pull requests, publishes it to `ghcr.io/<owner>/companion` tagged with the commit. The job summary prints the reference pinned by digest (`name@sha256:…`). The package is public, and an anonymous request for its manifest returns 200.

## The machine image

`infra/src/stacks.ts` has a `CompanionVmImage` stack. It holds an EC2 Image Builder pipeline and the launch template every user VM uses.

- **Build.** The pipeline starts a temporary Ubuntu 24.04 arm64 machine and runs `infra/image/install-host.sh`. That installs Docker, removes the SSH server, turns on automatic security patches, pulls the container image **by digest**, and adds two services: one that formats and mounts the data disk at `/data`, and one that runs the container. The container publishes no port. The script is plain shell, so it can be run by hand on a test machine.
- **Test before publishing.** A second machine runs `infra/image/test-host.sh`: the daemon is healthy on an empty data directory, and Chrome and a desktop app start. The AMI is published only if that passes.
- **Launch template `companion-user-vm`.** Metadata v2 only with one hop, no instance profile, the empty firewall, a 20 GB encrypted root disk, and a 30 GB encrypted data disk at `/dev/sdf` that is **not** deleted when the machine is. Every machine and disk carries `companion:managed=true`.
- **The data disk** is formatted once, on the first boot, with the label `companion` (XFS limits labels to 12 characters). A disk that already holds a different filesystem is never formatted. This is what lets the update flow (Task 4.5a) replace the machine without losing a bot.

Changing a script, or the image reference, gives the components a new name, because a published component cannot change.

## Running it

CI prints the digest. Then, from the repository root:

```
export AWS_PROFILE=companion COMPANION_ALERT_EMAIL=you@example.com
export COMPANION_IMAGE_REF=ghcr.io/<owner>/companion@sha256:<digest>
pnpm --filter @companion/infra deploy
aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <PipelineArn from the stack outputs>
infra/scripts/verify-image.sh <ami-id>
```

Deploying only this stack leaves the budget alarm alone: `cdk deploy --exclusively CompanionVmImage`.

## `verify-image`

`infra/scripts/verify-image.sh` launches the AMI the way a user VM launches, in the real network, and deletes it afterwards. It first reads the launch template: IMDSv2 required, no instance profile, a data disk that outlives the machine. It then launches the AMI and checks, with a temporary copy that gets the image builder's profile so SSM can run commands:

- the running instance requires IMDSv2,
- the daemon is healthy on a data disk that was empty at launch, and the disk is mounted and owned by the daemon,
- Chrome and a desktop app start,
- nothing listens on a non-loopback address, there is no SSH service, and the container's environment holds no key or token.

A failed check prints the services' status and logs from the machine before it is deleted.

## What the real runs found

- The first launch failed because the data-disk label was 14 characters and XFS allows 12. The pipeline's own test used a plain folder as the data disk and could not see this. Only the launch check did.
- One pipeline build failed because Chrome took more than 30 seconds to open its debugging port on a fresh machine. The first start reads Chrome from a disk that is still filling in from the snapshot. The daemon now waits 90 seconds, and the host test retries once. This is a likely cause, not a proven one.
- A VM boots with no model key, so the daemon now starts without one and turns fail at the provider until the control plane supplies a key (Task 5.1).

## Safety, and what is left for later

The checks above run on every image. The VM stays the boundary, and Chrome's own sandbox is off (see above). How a running VM moves to a newer image is Task 4.5a, and a schedule for monthly OS patches comes with it.
