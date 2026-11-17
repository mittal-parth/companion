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
  hostCommit: "c".repeat(40),
  hostAmi: "ami-0123456789abcdef0",
  relayDomain: "relay.example.com",
  // A registry image, so synthesis in tests does not stage the repo as an asset.
  relayImageRef: `ghcr.io/example/relay@sha256:${"b".repeat(64)}`,
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
    host: get("CompanionVmHost"),
    relayCert: get("CompanionRelayCert"),
    relay: get("CompanionRelay"),
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
  it("gives instance profiles only to the image builder and the host, never a user's computer", () => {
    const { roles } = templates();
    roles.resourceCountIs("AWS::IAM::InstanceProfile", 2);
    for (const name of ["companion-image-builder", "companion-host"]) {
      roles.hasResourceProperties("AWS::IAM::InstanceProfile", {
        InstanceProfileName: name,
      });
    }
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

  function statementsOf(template: ReturnType<typeof templates>["roles"]) {
    return Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
  }

  it("lets the provisioner create volumes only if they are encrypted and tagged, and touch no instance", () => {
    const { roles } = templates();
    const provisioner = Object.values(
      roles.findResources("AWS::IAM::Policy"),
    ).find((p) =>
      JSON.stringify(p.Properties.Roles).includes("ProvisionerRole"),
    );
    const statements = provisioner!.Properties.PolicyDocument.Statement as {
      Action: unknown;
      Condition?: unknown;
    }[];
    const actions = statements.flatMap((s) => [s.Action].flat() as string[]);
    expect(actions.sort()).toEqual([
      "ec2:CreateTags",
      "ec2:CreateVolume",
      "ec2:DescribeVolumes",
    ]);
    const create = statements.find((s) =>
      JSON.stringify(s.Action).includes("CreateVolume"),
    );
    expect(JSON.stringify(create?.Condition)).toContain(
      "aws:RequestTag/companion:managed",
    );
    expect(JSON.stringify(create?.Condition)).toContain(
      '"ec2:Encrypted":"true"',
    );
  });

  it("limits the host to attaching tagged volumes and reading its own parameters", () => {
    const { roles } = templates();
    const host = Object.values(roles.findResources("AWS::IAM::Policy")).find(
      (p) => JSON.stringify(p.Properties.Roles).includes("HostRole"),
    );
    const statements = host!.Properties.PolicyDocument.Statement as {
      Action: unknown;
      Resource: unknown;
      Condition?: unknown;
    }[];
    const attach = statements.filter((s) =>
      JSON.stringify(s.Action).includes("AttachVolume"),
    );
    expect(attach).toHaveLength(2);
    for (const statement of attach) {
      expect(JSON.stringify(statement.Condition)).toContain(
        "ec2:ResourceTag/companion:managed",
      );
    }
    const parameters = statements.find((s) =>
      JSON.stringify(s.Action).includes("ssm:GetParameter"),
    );
    expect(JSON.stringify(parameters?.Resource)).toContain(
      "parameter/companion/host/*",
    );
  });

  it("lets a scheduled wake start only tagged instances", () => {
    const { roles } = templates();
    const wake = statementsOf(roles).filter(
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
    COMPANION_HOST_COMMIT: config.hostCommit,
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
  it("builds on Ubuntu 24.04 x86 and runs the host test before publishing", () => {
    const { image } = templates();
    image.hasResourceProperties("AWS::ImageBuilder::ImageRecipe", {
      ParentImage:
        "arn:aws:imagebuilder:ap-south-1:aws:image/ubuntu-server-24-lts-x86/x.x.x",
    });
    image.hasResourceProperties("AWS::ImageBuilder::ImagePipeline", {
      ImageTestsConfiguration: { ImageTestsEnabled: true },
    });
    image.resourceCountIs("AWS::ImageBuilder::Component", 2);
  });

  it("passes the image digest and the commit to the install script", () => {
    const components = Object.values(
      templates().image.findResources("AWS::ImageBuilder::Component"),
    );
    const build = components.find((c) =>
      String(c.Properties.Name).includes("-build-"),
    );
    expect(String(build?.Properties.Data)).toContain(
      `bash /tmp/build-host.sh ${config.imageRef} ${config.hostCommit}`,
    );
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

  it("uses the empty firewall, never a new one with inbound rules", () => {
    const { image, host } = templates();
    for (const template of [image, host]) {
      template.resourceCountIs("AWS::EC2::SecurityGroup", 0);
      template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
    }
  });
});

describe("VM host", () => {
  function hostTemplate() {
    const { host } = templates();
    const [template] = Object.values(
      host.findResources("AWS::EC2::LaunchTemplate"),
    );
    return template!.Properties.LaunchTemplateData;
  }

  it("runs on one instance with nested virtualization, metadata v2 only and the host's role", () => {
    const data = hostTemplate();
    expect(data.CpuOptions.NestedVirtualization).toBe("enabled");
    expect(data.MetadataOptions.HttpTokens).toBe("required");
    expect(data.MetadataOptions.HttpPutResponseHopLimit).toBe(1);
    expect(data.IamInstanceProfile).toEqual({ Name: "companion-host" });
    templates().host.resourceCountIs("AWS::EC2::Instance", 1);
  });

  it("encrypts its disk and carries the managed tag", () => {
    const data = hostTemplate();
    expect(data.BlockDeviceMappings[0].Ebs.Encrypted).toBe(true);
    templates().host.hasResourceProperties("AWS::EC2::Instance", {
      Tags: [
        { Key: "companion:managed", Value: "true" },
        { Key: "Name", Value: "companion-host" },
      ],
    });
  });

  it("is told where the relay is and where its token lives, but is not given the token", () => {
    const text = JSON.stringify(hostTemplate().UserData);
    expect(text).toBeDefined();
    const decoded = JSON.stringify(templates().host.toJSON());
    expect(decoded).toContain("COMPANION_HOST_PARAMS_PREFIX=/companion/host");
    expect(decoded).not.toMatch(/COMPANION_HOST_TOKEN|relayToken/);
  });

  it("is built only once a host image exists", () => {
    const app = buildApp({ ...config, hostAmi: undefined });
    expect(app.node.tryFindChild("CompanionVmHost")).toBeUndefined();
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
      loadConfig({
        ...base,
        COMPANION_IMAGE_REF: config.imageRef,
        COMPANION_HOST_COMMIT: config.hostCommit,
      }).imageRef,
    ).toBe(config.imageRef);
  });

  it("needs a full commit for the host agent", () => {
    expect(() =>
      loadConfig({
        ...base,
        COMPANION_IMAGE_REF: config.imageRef,
        COMPANION_HOST_COMMIT: "main",
      }),
    ).toThrow(/commit/);
  });
});

describe("relay", () => {
  it("is built only when a relay domain is configured", () => {
    const app = buildApp({ ...config, relayDomain: undefined });
    expect(app.node.tryFindChild("CompanionRelay")).toBeUndefined();
    expect(app.node.tryFindChild("CompanionRelayCert")).toBeUndefined();
  });

  it("proves the certificate by DNS, so the operator adds the record", () => {
    templates().relayCert.hasResourceProperties(
      "AWS::CertificateManager::Certificate",
      { DomainName: "relay.example.com", ValidationMethod: "DNS" },
    );
  });

  it("serves HTTPS, redirects HTTP, and keeps long streams open", () => {
    const { relay } = templates();
    relay.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
    });
    relay.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [
        {
          Type: "redirect",
          RedirectConfig: {
            Protocol: "HTTPS",
            Port: "443",
            StatusCode: "HTTP_301",
          },
        },
      ],
    });
    relay.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internet-facing",
      LoadBalancerAttributes: [
        { Key: "deletion_protection.enabled", Value: "false" },
        { Key: "idle_timeout.timeout_seconds", Value: "3600" },
      ],
    });
  });

  it("lets the task be reached by the load balancer only", () => {
    const { relay } = templates();
    // No inbound rule on any group names an address range except the balancer's own.
    const groups = relay.findResources("AWS::EC2::SecurityGroup");
    const open = Object.entries(groups).filter(([, g]) =>
      (g.Properties.SecurityGroupIngress ?? []).some(
        (rule: { CidrIp?: string }) => rule.CidrIp === "0.0.0.0/0",
      ),
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.[0]).toMatch(/Balancer/);
    relay.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      IpProtocol: "tcp",
      FromPort: 8080,
      ToPort: 8080,
    });
    relay.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("runs one arm64 task and passes the secret by reference, not by value", () => {
    const { relay } = templates();
    relay.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 1 });
    relay.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RuntimePlatform: { CpuArchitecture: "ARM64" },
    });
    const [task] = Object.values(
      relay.findResources("AWS::ECS::TaskDefinition"),
    );
    const container = task!.Properties.ContainerDefinitions[0];
    expect(JSON.stringify(container.Environment)).not.toContain("RELAY_SECRET");
    expect(container.Secrets).toHaveLength(1);
    expect(container.Secrets[0].Name).toBe("RELAY_SECRET");
    relay.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
    });
  });
});

describe("relay config", () => {
  it("refuses a relay image that is not pinned by digest", () => {
    expect(() =>
      loadConfig({
        CDK_DEFAULT_ACCOUNT: "111111111111",
        COMPANION_ALERT_EMAIL: "ops@example.com",
        COMPANION_IMAGE_REF: config.imageRef,
        COMPANION_HOST_COMMIT: config.hostCommit,
        COMPANION_RELAY_IMAGE_REF: "ghcr.io/example/relay:latest",
      }),
    ).toThrow(/digest/);
  });
});
