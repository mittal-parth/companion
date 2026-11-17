# Spike: a user's computer as a Lambda MicroVM

Status: done (run 2026-11-16 and 17, us-east-1). Write the results into the Results section at the end of this page.

## Why this spike exists

Task 4.5 (`docs/phase-4-5.md`, ADR 0005) runs every user's computer as a Firecracker microVM on EC2 hosts that we run ourselves: a host agent, our own Firecracker runner, our own firewall rules, EBS volumes moved between hosts, and a host image. That is a lot to own.

AWS now runs Firecracker microVMs for us: **Lambda MicroVMs** (launched June 2026). If a user's computer works there, most of the 4.5 build (`apps/host`, `infra/image/install-host.sh`, the host stack, `infra/image/guest-init.sh`) can be deleted. This spike finds out, in about a day, whether it works for everything a user's computer needs.

We looked at the alternatives and set them aside: E2B's open-source runtime (free self-hosting is one machine only), Perplexity SPACE (needs an EKS cluster on bare-metal nodes), Kubernetes agent-sandbox (needs EBS volumes again), AgentCore Runtime (its storage is wiped on every deploy, or it wakes too slowly), and Fargate (wakes too slowly).

## What you need to know about Lambda MicroVMs

Read these AWS pages before starting. They are short.

- Overview: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
- Getting started (has the build role's trust policy): https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html
- Images and snapshot compatibility: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
- Running, hooks, suspend and resume: https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
- Networking: https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html

The facts the design below depends on:

- **An image is a snapshot.** You give Lambda a zip in S3 holding a `Dockerfile`. Lambda builds it, starts your `ENTRYPOINT`, waits for your `/ready` hook to answer 200, then snapshots memory and disk. Every MicroVM starts from that snapshot. So **nothing user-specific may be in the image or running when the snapshot is taken.**
- **Per-user settings arrive in `runHookPayload`**, a string of at most 16 KB passed to `run-microvm`. Lambda POSTs it to your `/run` hook as `{"microvmId": "...", "runHookPayload": "..."}`.
- **Hooks** are HTTP endpoints your program serves at `/aws/lambda-microvms/runtime/v1/<name>` on a port you choose: `ready` and `validate` (during the image build), `run`, `suspend`, `resume`, `terminate`.
- **A MicroVM lives at most 8 hours** (`--maximum-duration-in-seconds`, at most 28,800), counting suspended time. When it is terminated, its disk is gone for good. That is why this spike saves `/data` to S3.
- **Suspend keeps memory and disk.** A suspended MicroVM costs only snapshot storage.
- **Auto-suspend counts only traffic arriving at the MicroVM's own endpoint.** Our daemon dials out to the relay, so that traffic probably does not count. Step 6 checks this.
- **Sizes:** memory sets the size; vCPU follows (2 GB = 1 vCPU) and can burst to 4×. Disk is 8 GB for the 2 GB size and 16 GB for the 4 GB size. **Use the 4 GB size** in this spike.
- **Architecture:** arm64 (the default) or x86. **Use arm64.** The image on `main` is already arm64 (ADR 0004).
- **Outbound traffic** goes to the public internet by default. Use that. Do not create a VPC connector.

## Ground rules

- **Branch.** Start a new branch `spike/lambda-microvms` from `main`, not from `feat/4-5-microvm-hosts`, and copy this page into it. Do not change `feat/4-5-microvm-hosts`. It is the fallback if this spike fails.
- **Do not change product code** (`apps/`, `packages/`) unless a step says so. Put everything you write under `infra/spike/lambda/`. Use environment variables the daemon already reads before changing it.
- **Region: `us-east-1`** for everything you create. Do not touch any resource in `ap-south-1`: the relay there is used as it is.
- **Name and tag** everything you create with the prefix `companion-spike`, and the tag `project=companion-spike`, so the cleanup in step 12 can find it.
- **Secrets.** You need the relay's URL and `RELAY_SECRET`, and optionally a `SARVAM_API_KEY`. Ask the user for them. Never print them, log them, write them into a committed file, or put them in the image. The run payload carries secrets, so never log the payload either.
- **If you are stuck on one step for more than an hour,** write down what you tried and what happened under Results, then ask the user. Do not invent a result. A failed check written down honestly is a useful result.
- **Commit** your scripts and this page on the spike branch when you finish. Do not push or open a pull request unless the user asks.

## The design under test

```
laptop script (stands in for the control plane)
  ├─ mints a relay token for the MicroVM, presigns S3 URLs for the user's data
  └─ run-microvm  ──payload──▶  MicroVM (from the snapshot)
                                 └─ hooks server (port 9000, ENTRYPOINT, runs as root)
                                      /run       restore /data from S3, start the daemon as uid 1000
                                      /suspend   nothing
                                      /resume    nothing, records the time
                                      /terminate stop the daemon, save /data to S3
                                 daemon (port 3010) ──dials out──▶ relay (ap-south-1) ◀── laptop checks /health
```

### The run payload

The laptop script passes this JSON, as a string, in `--run-hook-payload`:

```json
{
  "userId": "spike-user-1",
  "relayUrl": "wss://<relay host>/vm",
  "vmToken": "<from mint-token vm spike-user-1 120>",
  "sarvamKey": "<optional>",
  "restoreUrl": "<presigned GET for s3://<bucket>/users/spike-user-1/data.tar.zst>",
  "saveUrl": "<presigned PUT for the same key>"
}
```

Use the relay URL exactly as the user gives it. Check `apps/daemon/src/tunnel.ts` for what `COMPANION_RELAY_URL` must look like.

Presigned URLs keep the MicroVM away from any AWS credentials: each URL reaches only that one user's file. They expire when the credentials that signed them expire. With temporary credentials (SSO), that is often 1 hour. That is fine for the spike; write the expiry you got into Results.

Mint tokens with `RELAY_SECRET=... node apps/relay/scripts/mint-token.ts <vm|web> <vm-id> [minutes]`. Use the user id as the vm id.

### The hooks server (`infra/spike/lambda/hooks.mjs`)

Plain JavaScript (`.mjs`), Node's standard library only, so it runs on the image's Node with nothing to install. It listens on port 9000 and logs one line per event with `Date.now()` to stdout (Lambda sends stdout to CloudWatch). Never log the payload.

| Path (under `/aws/lambda-microvms/runtime/v1/`) | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`, `validate`                             | Answer 200.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `run`                                           | Parse `runHookPayload` and keep it in memory only. Create `/data` if missing. GET `restoreUrl`. On 200, pipe the body through `zstd -d` into `tar -x -C /data`. On 404 (first run), start empty. Then `chown -R 1000:1000 /data`. Start the daemon with the same command and environment as the last lines of `infra/image/guest-init.sh` on `feat/4-5-microvm-hosts`, but values from the payload: `COMPANION_RELAY_URL`, `COMPANION_VM_TOKEN`, `SARVAM_API_KEY` if given, `COMPANION_DATA_DIR=/data`, `COMPANION_CHROME_SANDBOX=off`, `PORT=3010`. Answer 200 once the daemon process has started. |
| `suspend`                                       | Answer 200.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `resume`                                        | Log the time and answer 200.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `terminate`                                     | Send SIGTERM to the daemon. Wait for it to exit, at most 20 s (Chrome flushes its profile on SIGTERM). Run `tar -C /data -cf - . \| zstd -3` and PUT the result to `saveUrl`. Log the compressed size and how long it took. Answer 200.                                                                                                                                                                                                                                                                                                                                                              |

Two extra routes on the same port, for testing only:

- `POST /spike/save` saves while the daemon keeps running (step 7).
- `GET /spike/status` answers `{ "daemonPid": ..., "lastSave": ... }`.

Lambda forwards traffic by port and does not check the path. So these routes, and the hooks, are reachable by anyone holding a token for port 9000. That is acceptable in a spike. In production, the hooks get a port no caller's token allows.

### The image

1. Build the `live-test` stage of `main`'s `Dockerfile` for `linux/arm64`. Push it to a private ECR repository `companion-spike` in `us-east-1`, and pin it by digest. The `live-test` stage already holds the test runner, so one image serves both timing and tests. Timings may be a little slower than the plain `runtime` stage would give; note that.
2. The MicroVM image's own `Dockerfile` (in the zip with `hooks.mjs`):

   ```dockerfile
   FROM <account>.dkr.ecr.us-east-1.amazonaws.com/companion-spike@sha256:<digest>
   USER root
   RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 zstd curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
   COPY hooks.mjs /opt/spike/hooks.mjs
   ENTRYPOINT ["node", "/opt/spike/hooks.mjs"]
   ```

   If `node` is not on the path as root, find where the image installs it (`which node` as the `companion` user) and use that full path.

3. Create the image with `aws lambda-microvms create-microvm-image`:
   - the base image `arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`, at a version that lists `ARM_64` (`list-managed-microvm-image-versions`);
   - memory for the 4 GB size;
   - the hook port 9000, with `ready` and `validate` turned on;
   - a build role that can read the zip from S3 and pull from ECR (the images page lists the ECR permissions; the getting-started page has the trust policy).

   Wait until the version's state is `SUCCESSFUL`. Build logs are in CloudWatch under `/aws/lambda-microvms/<image-name>`.

If the build fails because the Dockerfile's `VOLUME /data` gets in the way, set `COMPANION_DATA_DIR` to another folder (say `/home/companion/data`) everywhere in this design, and say so in Results.

### The laptop script (`infra/spike/lambda/spike.ts`)

One TypeScript file run with `pnpm exec tsx infra/spike/lambda/spike.ts <command> <userId>`. Use the AWS SDK for JavaScript v3: `@aws-sdk/client-lambda-microvms`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`. Add them to `infra`'s devDependencies. Keep each MicroVM's id and endpoint in `infra/spike/lambda/.state.json`, and add that file to `.gitignore`. Time everything with `performance.now()`.

| Command                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run <userId> [maxSeconds]` | Mints the vm token, presigns both URLs, calls `RunMicrovm` with the payload. Uses ingress `HTTP_INGRESS` and `SHELL_INGRESS`, egress `INTERNET_EGRESS`, idle policy `{"autoResumeEnabled": false, "maxIdleDurationSeconds": 28800, "suspendedDurationSeconds": 28800}`, and `maxSeconds` (default 7200). Then polls the relay's `/health` with a `web` token every 100 ms until it answers 200. Prints the time to the API's answer, to `RUNNING`, and to the relay `/health`. |
| `suspend <userId>`          | `SuspendMicrovm`, then polls the state until `SUSPENDED`. Prints how long it took.                                                                                                                                                                                                                                                                                                                                                                                             |
| `resume <userId>`           | `ResumeMicrovm`, then polls the relay `/health` until 200. Prints the time to `RUNNING` and to `/health`.                                                                                                                                                                                                                                                                                                                                                                      |
| `terminate <userId>`        | `TerminateMicrovm`, then polls until `TERMINATED`. Prints how long it took, and the size of the saved object in S3.                                                                                                                                                                                                                                                                                                                                                            |
| `health <userId>`           | One relay `/health` call, printing the status code and time.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get <userId> <path>`       | A GET through the relay with a `web` token, such as `/bots`. Prints the body.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `shell <userId>`            | Prints the command to open a shell (`create-microvm-shell-auth-token`, then the shell connection the docs describe).                                                                                                                                                                                                                                                                                                                                                           |

Through the relay, a caller sends `Authorization: Bearer <web token>` to `https://<relay host><path>`, and the relay forwards `<path>` to the daemon (see `apps/relay/src/relay.ts`).

## Steps

Do them in order. After each step, fill in its row in Results.

### 1. One-time setup

In `us-east-1`, create:

- an S3 bucket `companion-spike-<account id>`, with public access blocked and default encryption on;
- the ECR repository `companion-spike`;
- the build role `companion-spike-build`.

Check the account's quota for MicroVM memory in Service Quotas (search "Lambda MicroVMs"), and write it down. If it is below 16 GB, request 64 GB and tell the user.

### 2. Build the image

Follow "The image" above. Write down the image size in ECR, how long the MicroVM image build took, and any build errors and their fixes.

### 3. Chrome, the virtual screen and the desktop tools

Run one MicroVM (`run spike-user-1`), open a shell in it, and as the `companion` user, in `/app`, run the same checks the 4.5 spike ran (`docs/phase-4-5.md`, "Chrome, agent-browser and agent-desktop in a microVM"):

```bash
cd /app/apps/daemon && tsx scripts/smoke-stack.ts
cd /app && pnpm exec vitest run apps/daemon/tests/browser.test.ts apps/daemon/tests/desktop.test.ts apps/daemon/tests/browser-cli.test.ts apps/daemon/tests/desktop-cli.test.ts
```

If `pnpm` is missing in the image, look at how the `live-test` stage expects tests to be run (its comments, and `.github/workflows/ci.yml`), and run them that way.

**Pass:** the smoke check and every test pass. Write down the count, for example 28 of 28. If something fails, write down the error. The 4.5 spike found two such things on a read-only root (agent-browser's executable bit, vitest's cache); say whether either appears here.

### 4. Wake time from the snapshot, with an empty `/data`

Terminate the MicroVM, delete the user's object in S3, and run `run spike-user-2` five times (terminate after each). Write down every run's time to `RUNNING` and to relay `/health`.

**Pass:** the median time to relay `/health` is at most 5 s. The 4.5 spike measured about 3.2 s on our own host.

### 5. Suspend and resume

1. Run `spike-user-3`. In a shell, open a page in the daemon's Chrome so there is something in memory. Chrome's debugging port number is the first line of the `DevToolsActivePort` file in its profile, under `/data` (`find /data -name DevToolsActivePort`). Then run `curl -X PUT "http://127.0.0.1:<port>/json/new?https://example.com"`.
2. `suspend`, then `resume`. Do it five times.
3. After the last resume, check in a shell that the Chrome process and the `opencode` process have the same PIDs as before.

**Pass:** the median time from `ResumeMicrovm` to relay `/health` is at most 3 s, and the processes survived.

If the relay `/health` takes much longer than `RUNNING`, the daemon's connection to the relay was left half-open by the suspend. It reconnects only after 60 s of silence (`docs/phase-4-3.md`). Write down the time anyway, and note that the fix would be for `/resume` to tell the daemon to reconnect at once. Do not change the daemon in this spike.

### 6. Does the idle policy see our traffic?

1. Run `spike-user-4` with `autoResumeEnabled: false` and `maxIdleDurationSeconds: 120`. That is a different idle policy from the script's default, so add an option for it.
2. Keep the relay busy: call `health spike-user-4` every 10 s for 5 minutes.
3. Watch the MicroVM's state.

**Record:** whether it suspended while the relay was busy. We expect it to, because the traffic comes in through the relay, not the MicroVM's endpoint. If it does, the production design has to suspend and resume computers from the control plane itself, as DuskBot does. That is a finding for the design, not a failure of the spike.

### 7. The user's data across the 8-hour limit

This is the most important step.

1. **Make real data.** Run `spike-user-5` with a `maxSeconds` of 900 (15 minutes), so it hits the lifetime limit inside the test.
   - Open `https://httpbin.org/cookies/set?spike=1` in its Chrome, the same way as step 5.
   - If you have a Sarvam key, create a bot: POST `/bots` through the relay with `{"name": "Spike"}`. Its opening turn needs the model.
   - Write a marker file: `/data/spike-marker.txt` containing the current time.
   - In a shell, write down `du -sh /data`.
2. **Let the limit end it.** Wait for Lambda to terminate it at 15 minutes. Do not call terminate yourself. Check in CloudWatch that `/terminate` ran and the save finished. Write down the compressed size and how long the save took.
3. **Bring it back.** `run spike-user-5` again, which restores from S3. Time it to relay `/health`. Then check:
   - the marker file has the same content;
   - `GET /bots` through the relay lists the same bots as before;
   - Chrome's `Cookies` database holds the cookie. Run `sqlite3 <profile>/Default/Cookies "select name from cookies where host_key like '%httpbin%'"` and expect `spike`.
4. **Measure what a crash would lose.** Call `POST /spike/save` on port 9000 while the daemon runs. This is the save a crash would fall back on, so it must not stop the daemon. For each SQLite file under `/data` (find them with `find /data -type f -exec sh -c 'head -c 16 "$1" | grep -q "SQLite format 3" && echo "$1"' _ {} \;`), copy it with `sqlite3 <file> ".backup <copy>"` into a staging folder. Copy every other file as it is. Then tar, compress and PUT the staging folder. Write down which SQLite files could not be backed up while running (Chrome holds some of its databases locked), and how long the save took.

**Pass:**

- everything in 3 survives a termination at the lifetime limit;
- a run that restores `/data` reaches relay `/health` in at most 5 s, with the `/data` size you wrote down.

If the restore pushes the wake past 5 s, write down the restore time separately from the rest of the wake. It decides whether the production design needs something smarter, such as starting the daemon before Chrome's profile has finished downloading.

### 8. Isolation

In a shell in one MicroVM:

- `env | grep -i aws` shows nothing;
- `curl -m 3 http://169.254.169.254/latest/meta-data/` and `curl -m 3 http://169.254.170.2/` both fail or answer with nothing useful;
- `ip addr` shows its address.

Then run a second MicroVM and check:

- from the first one, `curl -m 3 http://<second's address>:3010/health` fails;
- calling the second one's endpoint with no token, or with the first one's token, answers 403.

**Pass:** all of the above.

### 9. Websites that block datacenter addresses

DuskBot found that some sites block or challenge a bot's browser from cloud addresses. From a MicroVM, open each of these in the daemon's Chrome:

- Google search for "weather"
- amazon.com
- ebay.com
- reuters.com
- linkedin.com
- bing.com
- github.com
- wikipedia.org
- youtube.com
- airbnb.com

Use `agent-browser`, connected to Chrome's debugging port. `apps/daemon/src/browser-cli.ts` shows how bots call it. Take a screenshot of each after 10 s.

**Record:** a table of site and result: loads, challenge or captcha, blocked. Save the screenshots under `infra/spike/lambda/results/` and do not commit them.

### 10. An image update

1. Build a second image version with any harmless change, such as a comment in `hooks.mjs`. If the user names a newer OpenCode version, build with that instead.
2. Run `spike-user-5` on the new version (`--image-version`), which restores the same `/data`.

**Pass:** `GET /bots` and the marker file are intact, and if there are bots, `GET /bots/<id>` returns the transcript. Say whether OpenCode's version changed.

### 11. Cost

Read the prices at https://aws.amazon.com/lambda/pricing/ (the MicroVMs section). Work out the monthly cost of one user of the 4 GB size:

- running 2 hours a day and suspended the rest;
- running 8 hours a day and suspended the rest.

Include snapshot storage and S3 for the saved data. Show the formula and the prices you used.

### 12. Clean up

Terminate every MicroVM. Delete the MicroVM image, the ECR repository, the S3 bucket (empty it first) and the build role. Check with `list-microvms` that nothing is left. Leave everything in `ap-south-1` alone.

## Decision

The spike **passes** when steps 3, 4, 5, 7 and 8 pass. Then the next step is an ADR that replaces ADR 0005, and a plan to replace `apps/host` with calls to Lambda from `reconcile`. If any of those five fails, write which and why. The Firecracker branch stays the plan, and the user decides.

Steps 6, 9, 10 and 11 shape the design but do not decide it.

## Results

Image: `live-test` stage, arm64, 1.42 GB in ECR (compressed), 4 GB MicroVM size, base image `al2023-1` v3. Image versions 1.0 to 2.0 and 6.0 built; 3.0 to 5.0 failed (see "Surprises"). All steps ran on version 2.0 except step 10 (6.0).

| Step                                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Setup, memory quota                                                                    | Bucket, ECR repo and build role created. Quota "Max allocated ARM_64 MicroVM memory" is **8 GB** (enough for two 4 GB MicroVMs). Requesting 64 GB was rejected: Service Quotas says the value must exceed the default of 2048 (the units look inconsistent), so no increase was made.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2. Image size, build time, errors                                                         | 1.42 GB in ECR. MicroVM image build 231 s (including validate). Errors: `runHookPayload` is limited to **4096 characters**, not 16 KB (the docs say 16 KB); two presigned URLs from SSO credentials exceed that, so the payload is gzipped and base64 (2.4 KB). `get-microvm-image` and `run-microvm` need the image **ARN**, not its name. `terminateTimeoutInSeconds` is capped at 60 s. `VOLUME /data` caused no problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3. Smoke check and tests                                                                  | **Pass.** `smoke-stack` passes (Chrome 157, galculator, 10 s). The four test files pass **28 of 28** (run with `/app/node_modules/.bin/vitest`; there is no `pnpm`). Neither read-only-root problem appeared (the root is writable). Needs `COMPANION_CHROME_SANDBOX=off`; without it Chrome never opened its debugging port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4. Wake from snapshot, empty data (5 runs, median)                                        | **Fail.** Time to `RUNNING`: 5.5, 5.3, 7.9, 5.4, 4.7 s (median 5.4 s; the `RunMicrovm` call alone takes about 3 s). Time until the daemon answers through the relay: 18.3, 16.0, 38.8, 12.7, 6.5 s, **median 16.0 s** (limit 5 s). Two other first runs took 39.5 and 19.8 s. The daemon starts in `/run`, and its first start reads cold files lazily from the snapshot; the fastest run (6.5 s) suggests it is faster when the snapshot is warm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5. Suspend time; resume to relay `/health` (5 runs, median); processes survived           | Suspend 2.6 s median (2.2 to 2.8). `ResumeMicrovm` to `RUNNING` 2.6 s. Resume to the daemon answering through the relay 3.9, 3.8, 3.9, 3.8, 4.1 s, **median 3.9 s (limit 3 s: narrow miss)**. Chrome, `opencode acp`, `opencode serve` and the daemon kept the same PIDs and the open page survived. The relay had dropped the VM while suspended, so the daemon reconnected on resume; no 60 s wait was seen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6. Idle policy with relay traffic only                                                    | **It suspended at about 120 s while the relay was being called every 10 s.** The relay traffic does not count as endpoint traffic. The control plane must suspend and resume computers itself. After suspension the relay answered 503 (VM not connected).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7. `/data` size; save time and size; wake with restore; data intact; online save failures | `/data` 79 MB after one Chrome page (187 MB after a second run). Lifetime-limit termination (15 min, not called by us) **did run `/terminate` and saved**: 108.6 MB compressed, finished 3 s before the termination was seen; explicit terminate with save takes 3.7 to 5.9 s. Restore run: `RUNNING` 8.9 s, daemon through the relay 10.2 s (the `/run` hook waits for the download, so the restore is most of the extra time). Intact: marker file, `GET /bots`, bot transcript, and the `spike` cookie after the first restore (Chrome drops session cookies when it is started again, so it was gone after a second restart; that is Chrome, not the save). Online save (`POST /spike/save`, daemon and Chrome running): 108.6 MB in 1.7 s, daemon not stopped. 20 SQLite files backed up; **9 could not be backed up while running**: `Default/History`, `Default/Web Data`, `Default/DIPS`, `Default/WebStorage/QuotaManager`, `Default/declarative_performance_observer.db`, `Default/Collaboration/MessageDB`, `Default/DataSharing/DataSharingDB`, `segmentation_platform/ukm_db`, `GPUPersistentCache/.../cache.db` (my staging step drops them; it should fall back to a plain copy). **A MicroVM that is terminated while suspended does not run `/terminate` and saves nothing** (tested). So the 8 h limit can lose data if the VM is suspended then. |
| 8. Isolation                                                                              | **Pass.** No AWS variables in the shell. `169.254.170.2` fails; `169.254.169.254` answers 401, and with a token only `placement/` and `tags/` (no IAM role, no credentials). Every MicroVM shows `169.254.0.2` plus a public IPv6 address; from one MicroVM, port 3010 and 9000 of another time out. The endpoint answers 403 with no token and with another MicroVM's token. `ip` and `ping` are not installed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9. Websites                                                                               | Google search: **blocked** (redirected to `/sorry` captcha). Reuters: **blocked** (DataDome "Verification Required", names the datacenter IP). Amazon: **interstitial** ("Click the button below to continue shopping"). eBay: error page on the first load, normal on the second. LinkedIn, Bing, GitHub, Wikipedia, YouTube, Airbnb: **load**. Screenshots in `infra/spike/lambda/results/` (four of ten pulled out, not committed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10. Image update                                                                          | **Pass.** Version 6.0 (a comment in `hooks.mjs`) restored the same `/data`: marker intact, `GET /bots` and `GET /bots/<id>` answered. OpenCode stayed v2.2.6 (same pinned base). Wake 9.7 s to `RUNNING`, 38.4 s to the daemon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11. Cost per user per month                                                               | 4 GB / 2 vCPU. Prices (us-east-1, arm64): $0.0000276944 per vCPU-s, $0.0000036667 per GB-s, snapshot storage $0.08 per GB-month, snapshot write $0.0038 per GB, snapshot read $0.00155 per GB. Running: 2 x 0.0000276944 + 4 x 0.0000036667 = $0.0000700556 per s = **$0.2522 per hour**. Assumed snapshot of a suspended VM: 4 GB memory + about 4.4 GB disk = 8.4 GB, one suspend and one resume per day. **2 h/day:** 60 h x 0.2522 = $15.13, storage 8.4 x 0.08 x 22/24 = $0.62, snapshot I/O 30 x 8.4 x (0.0038 + 0.00155) = $1.35, S3 about $0.003: **about $17.1**. **8 h/day:** 240 h x 0.2522 = $60.53, storage 8.4 x 0.08 x 16/24 = $0.45, I/O $1.35: **about $62.3**. Bursts above the baseline and data transfer are not included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 12. Cleanup done                                                                          | Done: every MicroVM TERMINATED (none running), MicroVM image, ECR repository, S3 bucket (emptied first), build role and the image log group deleted. `ap-south-1` untouched except one read of the relay secret, with your permission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Presigned URL expiry you got                                                              | Requested 12 h; the URL lives only as long as the signing credentials. The SSO session in use expired about 1 h after login (19:51 UTC for a 18:35 login), so effectively **under 1 h**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Anything that surprised you                                                               | (1) The relay answers a bare `/health` itself, so the spike polls `/health?t=<n>` to reach the daemon. (2) The relay URL for the daemon has no `/vm`. (3) The payload limit is 4096, not 16 KB. (4) The first Chrome start in a freshly woken MicroVM fails or takes over 60 s (it did in user-3, 5 and 6); a retry succeeds in under 1 s. (5) The entrypoint is PID 1 and does not reap children, so Chrome leaves zombie processes (an init such as `tini` is needed). (6) Terminating a suspended MicroVM skips `/terminate`. (7) Shell access is a websocket to `wss://<endpoint>/shell` on port 8022 (`exec.mjs` wraps it); run logs do not reach CloudWatch unless logging and an execution role are set, so the hook logs were never seen. (8) Versions 3.0 to 5.0 failed with "Validate hook invocation timed out after PT5M": a validate hook that ran the smoke check and the daemon to warm the snapshot never finished, cause not found. So the wake-time effect of warming the snapshot is **untested**. (9) The daemon's first wake is dominated by lazy loading from the snapshot, not by the hooks.                                                                                                                                                                                                                                                 |

## Outcome

**The spike does not pass on steps 4 and 5 as written; steps 3, 7 and 8 pass.**

- Step 4 fails (median 16 s against 5 s) and step 5 narrowly misses (3.9 s against 3 s). Neither is proven to be a hard limit: the daemon starts in `/run` and the snapshot is cold. Warming it in `/validate` (untested) or a daemon already running in the snapshot with only the relay token injected at `/run` are the next things to try.
- Step 7 passes, but the design needs the control plane to resume a suspended computer before the 8 h limit so `/terminate` can save, or to save in `/suspend`.
- Per the plan, the Firecracker branch stays the plan and the user decides.
