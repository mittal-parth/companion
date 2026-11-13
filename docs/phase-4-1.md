# Phase 4.1: AWS foundation

Nothing runs in AWS yet. This task creates the empty room later tasks use: a network for user VMs, the roles the control plane borrows to run them, and a spend alarm. No VM is launched and no API key is involved. It is written as code with AWS CDK (TypeScript) in `infra/`, so the whole thing can be deployed, deleted and rebuilt with one command.

## What gets created

`infra/src/stacks.ts` holds three stacks.

- **`CompanionVmNetwork`** is a private network (VPC) with two public subnets in two zones, and one firewall (security group) with **zero inbound rules**. A VM dials out to the relay (Task 4.3), so nothing from the internet needs to reach it. There is no NAT gateway, which costs about $32 a month each. VMs get public addresses for outbound traffic only, and the empty firewall keeps them unreachable.
- **`CompanionVmRoles`** holds three roles, each limited to one job.
  - `companion-provisioner` is borrowed by the control plane to launch, start, stop and delete user VMs (Tasks 4.4, 4.5). Start, stop and delete only work on instances tagged `companion:managed=true`, and a launched VM must carry that tag.
  - `companion-image-builder` and its instance profile are for the temporary machine that bakes the base image (Task 4.2). It is the only instance profile in the account. User VMs get no role at all.
  - `companion-scheduler` lets EventBridge Scheduler start a tagged, stopped VM before a job is due (Task 4.6).
- **`CompanionBudget`** emails the operator at 80% and 100% of a monthly limit, and when the forecast passes it. It warns only. It is not a per-user limit; those come in Phase 5.

## One account for now

Everything deploys to one AWS account, in separate stacks. `infra/src/config.ts` reads the account from your logged-in profile and keeps a second setting, `COMPANION_CONTROL_PLANE_ACCOUNT`, for the account that will borrow the provisioner role. Until it is set, it is the same account. Moving the VM side into its own account later means deploying the network and roles stacks there and pointing that setting at the control-plane account. The image is rebuilt in the new account.

## Run it

Log in with SSO, then deploy from `infra/`:

```
# Sign in to AWS through Identity Center; the login lasts a few hours, then repeat it.
aws sso login --profile companion
# Make every command below use that login.
export AWS_PROFILE=companion
# Where the budget alarm emails the operator.
export COMPANION_ALERT_EMAIL=you@example.com
# Monthly spend limit in USD for the alarm (optional, default 20).
export COMPANION_BUDGET_USD=20
# One-time setup of the helper resources CDK needs in this account and region.
pnpm --filter @companion/infra bootstrap
# Create or update the network, roles and budget in AWS.
pnpm --filter @companion/infra deploy
# Delete everything the stacks created.
pnpm --filter @companion/infra destroy
```

Changing the limit is a new `COMPANION_BUDGET_USD` and another `deploy`. The budget updates in place.

## Checks

`infra/tests/stacks.test.ts` reads the synthesized templates and fails if any of these promises weaken: no inbound rule on the firewall, no NAT gateway, one instance profile and it is the image builder's, start/stop/delete limited to tagged instances, no wildcard actions, and the three budget alerts. CI also runs `cdk synth`. Synthesis needs no AWS login because the two zones are named in code (`a` and `b` of the region) instead of looked up.
