# Phase 4.5: microVM hosts

A user's computer is a Firecracker microVM on a shared x86 host (ADR 0005). The first part of this page is the spike that justified it; the build follows it.

## The spike

Before building the lifecycle, we measured whether a user's computer can be a Firecracker microVM on a shared x86 EC2 host (ADR 0005). It can. This page records what was measured, on one `m8i.xlarge` (4 vCPU, 16 GiB, Intel, `ap-south-1`) with nested virtualization on, Ubuntu 24.04, Firecracker 1.18.0, guest kernel 6.1.155 from Firecracker's CI. The host was terminated afterwards and nothing from it is left running.

## What was built

The repo's own Dockerfile, with the arm64 lines swapped for amd64 and the OpenCode checksum check dropped (a spike shortcut), built on the host. Its filesystem became a read-only ext4 root image shared by every microVM. Each microVM got its own small `init`, a writable data volume (a file standing in for the user's EBS volume), a tap network device on its own /30 subnet, and ran under Firecracker's `jailer` as an unprivileged user in its own cgroup. `infra/spike/rootfs.sh` and `infra/spike/boot.sh` are the two scripts.

## Results

| Measurement                                                                                   | Result                                                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Nested virtualization on a normal (non-metal) x86 instance                                    | `/dev/kvm` present; Firecracker under the jailer runs                                               |
| Wake: from "start" to the daemon answering `/health`, data volume mounted, no memory snapshot | **about 3.2 s**, six runs from 3.17 to 3.36 s                                                       |
| Same wake with 8 microVMs already running                                                     | 3.3 to 3.5 s, so it did not slow down under load                                                    |
| Where the time goes                                                                           | kernel up and `init` running at about 1 s; the rest is the daemon starting (`tsx`, then the engine) |
| Host memory per idle microVM (daemon only, 2 GiB configured)                                  | about 490 MiB                                                                                       |
| Host memory per microVM with Chrome and a virtual screen added                                | about 1.08 GiB; wake to `/health` rose to 4.2 s while Chrome starts at the same time                |
| Attaching an EBS data volume to the host                                                      | about 1.9 s                                                                                         |
| Detaching an EBS data volume                                                                  | about 16.4 s                                                                                        |

## What it means

- **Disk-only wake is fast enough.** At about 3.2 s (4.2 s with Chrome starting) it is inside the 5 s budget and close to the 4 to 5 s seen on Grok Bot, so no memory snapshots are needed. The image can be updated without any snapshot becoming stale.
- **Density.** Eight idle microVMs used about 4.7 GiB of a 16 GiB host. With Chrome open each one is roughly twice that, so one 16 GiB host holds on the order of 10 to 15 working computers, not 30. That is a first estimate from one run.
- **The slow part is detaching a data volume.** A volume has to be detached from one host (about 16 s) before another host can attach it (about 2 s). It happens when a computer goes off, not when it wakes, so a user who comes back after a minute is unaffected. A wake on the same host should keep the volume attached for a while after the computer turns off and detach it later. A wake on a different host must wait for the detach to finish. Wake in that case is roughly 2 s plus 3.2 s.
- **A different host for a different user is cheap.** Nothing in the guest depends on the host it started on.

## Chrome, agent-browser and agent-desktop in a microVM

A second run used the image's `live-test` stage (the test runner is in it), with a microVM of 4 GiB and 2 vCPUs, and ran the model-free checks inside it: `apps/daemon/scripts/smoke-stack.ts`, then `browser.test.ts`, `desktop.test.ts`, `browser-cli.test.ts` and `desktop-cli.test.ts`. All passed: the smoke check (Chrome 157 answering on its debugging port, a window opened, `galculator` seen through the accessibility tree) and 28 of 28 tests, including two bots filling forms at once through agent-browser with a login that survives a restart, and two bots writing in their own desktop windows at once.

Two things this showed about the design:

- **A read-only root filesystem needs a few writable places.** agent-browser makes its own binary executable the first time it runs, so the image must set that bit at build time (the first run failed on exactly that). Vitest also writes a cache under `node_modules`, which only matters for the test runner, not the shipped image. Scratch folders (`/tmp`, `/run`, the home folder) were tmpfs.
- **Chrome's sandbox stayed off**, as in the container, so the microVM's isolation is what keeps a page from reaching the host, not Chrome.

## Not measured, and needed before building on this

- **Isolation between guests and outbound traffic.** Each microVM had its own tap device and subnet and no forwarding, so guests could not reach each other, but I did not test that, and I did not set up NAT. A guest needs outbound access to reach the relay, with a rule that blocks traffic between guests.
- **A real EBS volume as the guest's drive.** The data volume here was a file on the host disk. Passing an attached EBS block device to Firecracker should work but was not run.
- **The relay path and the LLM.** The daemon ran with a dummy key and no relay token, so no turn ran and no tunnel connected.
- **Cost and the OpenCode upgrade test.** No instance price was worked out, and the upgrade test from 4.5a was not run.

## Reproducing

On an x86 EC2 instance with nested virtualization enabled (`--cpu-options NestedVirtualization=enabled`), install Docker and the Firecracker release, fetch the guest kernel, build the Dockerfile with amd64 substitutions as `companion-x86`, then run `infra/spike/rootfs.sh` and `infra/spike/boot.sh N`.

## The build

**Control plane.** `reconcile` (apps/web/src/lib/vm.ts) provisions through two ports. A _volume_ port creates each user's EBS data volume once (looked up by owner first, created with a token that repeats) and never deletes it automatically. A _host_ port asks a host to run the computer, and repeating that is harmless, so it is repeated on every poll. The `vms` table keeps `volume_id` in place of an instance id (`supabase/migrations/20261115000000_vms_volume.sql`). A failed attempt keeps the volume, and Try again reuses it. The setup screen is unchanged.

**Host agent** (`apps/host`). Runs on the host, dials the relay under its own id (`host-1`) with the same tunnel client the daemon uses, and answers `POST /computers`, `GET /computers` and `DELETE /computers/:userId` on 127.0.0.1. It keeps a user to one computer, answers 507 when the host is full, releases everything when a start fails, and saves its list so computers come back in the same slots when the agent restarts. Two ports keep that testable: a _runner_ (Firecracker) and a _volume service_ (EBS).

**Runner** (`apps/host/src/firecracker.ts`). Each computer runs under the jailer as an unprivileged user in its own cgroup, with a read-only root filesystem shared by all, the user's volume as a block device, and a 2 MiB private drive holding the relay address and token. The token is never in an argument or in the machine description. Guests live in `100.64.0.0/16`, one /30 each, and reach the internet through NAT. A firewall chain blocks guest traffic to the private ranges, the metadata address and other guests, and the host drops everything a guest sends to it. The guests' DNS is a public resolver, because the VPC's resolver is in a blocked range.

**Guest** (`infra/image/guest-init.sh`). The first program in the microVM: it mounts the drives, reads the boot environment, drops to uid 1000 and runs the daemon.

**Image and host.** The container image is x86_64 (ADR 0005) and sets agent-browser's executable bit at build time because the root is read only. `infra/image/install-host.sh` turns a fresh Ubuntu 24.04 x86 machine into a host: Firecracker and the guest kernel pinned by checksum, Node, the agent at a given commit, the container image (by digest) unpacked into the shared root filesystem, no Docker and no remote login. The CDK `VmHostStack` runs one `m8i.xlarge` from that image with nested virtualization, metadata v2 only, no inbound ports and an instance role that can only attach tagged data volumes and read `/companion/host/*` from Parameter Store. The provisioner role now only creates tagged, encrypted volumes.

**A model key, for now.** The guests need a key until the LLM proxy (Task 5.1). It is read from the Parameter Store value `/companion/host/guest-env` into a root-only file on the host and copied into each guest's private drive. It does not travel through the web server or the repository. Remove the parameter to remove the key.

## Settings for a real run

| Setting                                              | Meaning                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMPANION_HOST_COMMIT`                              | the commit the image installs the agent from (must be pushed)                                                                                          |
| `COMPANION_IMAGE_REF`                                | the x86 container image, pinned by digest (CI prints it)                                                                                               |
| `COMPANION_HOST_AMI`                                 | the host image, set after the pipeline builds it; the host stack exists only when set                                                                  |
| `COMPANION_HOST_AZ` (web)                            | the host's zone: where data volumes are created (stack output `HostAvailabilityZone`)                                                                  |
| `COMPANION_HOST_ID` (web)                            | the host's relay id, `host-1` by default                                                                                                               |
| `/companion/host/token`, `/companion/host/guest-env` | Parameter Store values (SecureString): the host's relay token (`mint-token vm host-1 525600`) and optional guest settings such as `SARVAM_API_KEY=...` |

## Checks

- `apps/web/tests/vm.test.ts`: the state machine against fakes (concurrent requests, a crash after making the volume, a full host, timeouts, Try again reusing the volume).
- `apps/host/tests`: the agent's rules through its HTTP handler, and exactly what the runner would run (firewall rules, jailer arguments, the token only on the private drive).
- `infra/tests/stacks.test.ts`: the host's and provisioner's permissions and settings against the synthesized templates.
- On a real host: the model-free browser and desktop tests inside a microVM (`infra/spike/` scripts, as in the spike), then a user signing in, the setup screen provisioning a computer, and a turn through the relay.
