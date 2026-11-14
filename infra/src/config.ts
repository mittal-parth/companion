/**
 * What differs between AWS accounts and environments, kept out of the stacks.
 * Moving the VM side into its own account later is a change to this file's
 * inputs (account ids, region), not to the stacks.
 */

/** Everything the stacks need to know about where and how much. */
export type InfraConfig = {
  /** Account that holds the user VMs. */
  vmAccountId: string;
  /** Account that runs the control plane and assumes the provisioner role. */
  controlPlaneAccountId: string;
  region: string;
  /** Monthly spend in USD that the budget alarm is measured against. */
  budgetUsd: number;
  /** Who is emailed by the budget alarm. The operator, never an end user. */
  alertEmail: string;
  /**
   * The container image baked into the machine image, pinned by digest,
   * such as `ghcr.io/<owner>/companion@sha256:<digest>`. CI prints it.
   */
  imageRef: string;
};

/** Tag every user VM carries so roles can be limited to those instances. */
export const managedTag = { key: "companion:managed", value: "true" };

/**
 * Reads the config from the environment.
 * The account comes from the logged-in AWS profile (`CDK_DEFAULT_ACCOUNT`),
 * so no account id or email is committed. One account plays both roles until
 * `COMPANION_CONTROL_PLANE_ACCOUNT` names a different one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): InfraConfig {
  const vmAccountId = env.CDK_DEFAULT_ACCOUNT?.trim();
  if (!vmAccountId) {
    throw new Error("No AWS account. Log in with `aws sso login` first.");
  }
  const alertEmail = env.COMPANION_ALERT_EMAIL?.trim();
  if (!alertEmail) {
    throw new Error("Set COMPANION_ALERT_EMAIL for the budget alarm.");
  }
  const budgetUsd = Number(env.COMPANION_BUDGET_USD ?? "20");
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error("COMPANION_BUDGET_USD must be a positive number.");
  }
  const imageRef = env.COMPANION_IMAGE_REF?.trim();
  if (!imageRef || !/@sha256:[0-9a-f]{64}$/.test(imageRef)) {
    throw new Error(
      "Set COMPANION_IMAGE_REF to the image pinned by digest (name@sha256:...).",
    );
  }
  return {
    vmAccountId,
    controlPlaneAccountId:
      env.COMPANION_CONTROL_PLANE_ACCOUNT?.trim() || vmAccountId,
    region: env.CDK_DEFAULT_REGION?.trim() || "ap-south-1",
    budgetUsd,
    alertEmail,
    imageRef,
  };
}
