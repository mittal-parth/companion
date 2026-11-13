/**
 * Checks the safety promises of the AWS foundation against the synthesized
 * templates, so a change that weakens them fails here before it is deployed.
 */
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { type InfraConfig, loadConfig } from "../src/config.js";
import { buildApp } from "../src/stacks.js";

const config: InfraConfig = {
  vmAccountId: "111111111111",
  controlPlaneAccountId: "222222222222",
  region: "ap-south-1",
  budgetUsd: 20,
  alertEmail: "ops@example.com",
};

function templates() {
  const app = buildApp(config);
  const get = (name: string) =>
    Template.fromStack(
      app.node.findChild(name) as unknown as import("aws-cdk-lib").Stack,
    );
  return {
    network: get("CompanionVmNetwork"),
    roles: get("CompanionVmRoles"),
    budget: get("CompanionBudget"),
  };
}

describe("VM network", () => {
  it("has a firewall with no inbound rules and no ingress resources", () => {
    const { network } = templates();
    const groups = network.findResources("AWS::EC2::SecurityGroup");
    expect(Object.keys(groups)).toHaveLength(1);
    for (const group of Object.values(groups)) {
      expect(group.Properties.SecurityGroupIngress ?? []).toEqual([]);
    }
    network.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
  });

  it("has no NAT gateway", () => {
    templates().network.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("spreads subnets across two zones", () => {
    templates().network.resourceCountIs("AWS::EC2::Subnet", 2);
  });
});

describe("VM roles", () => {
  it("gives only the image builder an instance profile, never a user VM", () => {
    const { roles } = templates();
    roles.resourceCountIs("AWS::IAM::InstanceProfile", 1);
    roles.hasResourceProperties("AWS::IAM::InstanceProfile", {
      InstanceProfileName: "companion-image-builder",
    });
  });

  it("lets the control-plane account assume the provisioner", () => {
    templates().roles.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "companion-provisioner",
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
              AWS: {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    ":iam::222222222222:root",
                  ],
                ],
              },
            },
          },
        ],
      },
    });
  });

  it("limits start, stop and terminate to tagged instances", () => {
    const { roles } = templates();
    const policies = roles.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const lifecycle = statements.filter((s) =>
      JSON.stringify(s.Action).includes("TerminateInstances"),
    );
    expect(lifecycle).toHaveLength(1);
    expect(JSON.stringify(lifecycle[0]?.Condition)).toContain(
      "ec2:ResourceTag/companion:managed",
    );
    const wake = statements.filter(
      (s) => JSON.stringify(s.Action) === '"ec2:StartInstances"',
    );
    expect(wake).toHaveLength(1);
    expect(JSON.stringify(wake[0]?.Condition)).toContain(
      "ec2:ResourceTag/companion:managed",
    );
  });

  it("never allows a wildcard action", () => {
    const { roles } = templates();
    const policies = roles.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        expect(JSON.stringify(s.Action)).not.toMatch(/"\*"|:\*"/);
      }
    }
  });
});

describe("budget", () => {
  it("emails at 80% and 100% actual and 100% forecast", () => {
    const { budget } = templates();
    budget.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 20, Unit: "USD" },
      },
      NotificationsWithSubscribers: [
        {
          Notification: { NotificationType: "ACTUAL", Threshold: 80 },
          Subscribers: [{ Address: "ops@example.com" }],
        },
        {
          Notification: { NotificationType: "ACTUAL", Threshold: 100 },
          Subscribers: [{ Address: "ops@example.com" }],
        },
        {
          Notification: { NotificationType: "FORECASTED", Threshold: 100 },
          Subscribers: [{ Address: "ops@example.com" }],
        },
      ],
    });
  });
});

describe("loadConfig", () => {
  const base = {
    CDK_DEFAULT_ACCOUNT: "111111111111",
    COMPANION_ALERT_EMAIL: "a@b.co",
  };

  it("uses one account for both roles until told otherwise", () => {
    const c = loadConfig(base);
    expect(c.controlPlaneAccountId).toBe("111111111111");
    expect(c.region).toBe("ap-south-1");
    expect(c.budgetUsd).toBe(20);
  });

  it("rejects a missing account, a missing email and a bad budget", () => {
    expect(() => loadConfig({ COMPANION_ALERT_EMAIL: "a@b.co" })).toThrow(
      /account/i,
    );
    expect(() => loadConfig({ CDK_DEFAULT_ACCOUNT: "1" })).toThrow(/EMAIL/);
    expect(() => loadConfig({ ...base, COMPANION_BUDGET_USD: "-5" })).toThrow(
      /positive/,
    );
  });
});
