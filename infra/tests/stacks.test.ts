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
  imageRef: `ghcr.io/example/companion@sha256:${"a".repeat(64)}`,
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
    image: get("CompanionVmImage"),
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
    COMPANION_IMAGE_REF: config.imageRef,
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

describe("VM image", () => {
  it("launches user VMs with metadata v2 only and no instance role", () => {
    const { image } = templates();
    const [template] = Object.values(
      image.findResources("AWS::EC2::LaunchTemplate"),
    );
    const data = template!.Properties.LaunchTemplateData;
    expect(data.MetadataOptions.HttpTokens).toBe("required");
    expect(data.MetadataOptions.HttpPutResponseHopLimit).toBe(1);
    expect(data.IamInstanceProfile).toBeUndefined();
  });

  it("keeps user data on a separate disk that outlives the machine", () => {
    const { image } = templates();
    const [template] = Object.values(
      image.findResources("AWS::EC2::LaunchTemplate"),
    );
    const disks = template!.Properties.LaunchTemplateData
      .BlockDeviceMappings as {
      DeviceName: string;
      Ebs: Record<string, unknown>;
    }[];
    const data = disks.find((disk) => disk.DeviceName === "/dev/sdf");
    expect(data?.Ebs.DeleteOnTermination).toBe(false);
    expect(data?.Ebs.Encrypted).toBe(true);
    expect(
      disks.find((disk) => disk.DeviceName === "/dev/sda1")?.Ebs
        .DeleteOnTermination,
    ).toBe(true);
  });

  it("tags every user VM and its disks so roles can find them", () => {
    const { image } = templates();
    image.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: {
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [{ Key: "companion:managed", Value: "true" }],
          },
          {
            ResourceType: "volume",
            Tags: [{ Key: "companion:managed", Value: "true" }],
          },
        ],
      },
    });
  });

  it("uses the empty firewall, never a new one with inbound rules", () => {
    const { image } = templates();
    image.resourceCountIs("AWS::EC2::SecurityGroup", 0);
    image.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
  });

  it("builds on Ubuntu 24.04 arm64 and runs the host test before publishing", () => {
    const { image } = templates();
    image.hasResourceProperties("AWS::ImageBuilder::ImageRecipe", {
      ParentImage:
        "arn:aws:imagebuilder:ap-south-1:aws:image/ubuntu-server-24-lts-arm64/x.x.x",
    });
    image.hasResourceProperties("AWS::ImageBuilder::ImagePipeline", {
      ImageTestsConfiguration: { ImageTestsEnabled: true },
    });
    image.resourceCountIs("AWS::ImageBuilder::Component", 2);
  });

  it("writes each component as a list of named phases, as Image Builder requires", () => {
    const components = Object.values(
      templates().image.findResources("AWS::ImageBuilder::Component"),
    );
    expect(components).toHaveLength(2);
    for (const kind of ["build", "test"]) {
      const component = components.find((resource) =>
        String(resource.Properties.Name).includes(`-${kind}-`),
      );
      expect(String(component?.Properties.Data)).toContain(
        `phases:\n  - name: ${kind}\n    steps:\n`,
      );
    }
  });

  it("builds on the build machine's profile and no other", () => {
    templates().image.hasResourceProperties(
      "AWS::ImageBuilder::InfrastructureConfiguration",
      { InstanceProfileName: "companion-image-builder" },
    );
  });
});

describe("image reference", () => {
  const base = {
    CDK_DEFAULT_ACCOUNT: "111111111111",
    COMPANION_ALERT_EMAIL: "ops@example.com",
  };

  it("refuses an image that is not pinned by digest", () => {
    expect(() =>
      loadConfig({
        ...base,
        COMPANION_IMAGE_REF: "ghcr.io/example/companion:latest",
      }),
    ).toThrow(/digest/);
  });

  it("accepts an image pinned by digest", () => {
    expect(
      loadConfig({ ...base, COMPANION_IMAGE_REF: config.imageRef }).imageRef,
    ).toBe(config.imageRef);
  });
});
