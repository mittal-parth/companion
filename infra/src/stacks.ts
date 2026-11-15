/**
 * The AWS pieces that exist before any user VM does: the network VMs will sit
 * in, the roles the control plane borrows to run them, and the spend alarm.
 *
 * The VM side (network, roles) and the account-wide budget are separate
 * stacks, so moving the VM side into its own AWS account later is a config
 * change and a redeploy, not a rewrite.
 */
import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as imagebuilder from "aws-cdk-lib/aws-imagebuilder";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Construct } from "constructs";
import { type InfraConfig, managedTag } from "./config.js";
import { RelayCertStack, RelayStack } from "./relay.js";

/** Where the host's relay token and guest settings live in Parameter Store. */
export const hostParametersPrefix = "/companion/host";

/** The network a user VM is launched into. */
export type VmNetwork = {
  vpc: ec2.Vpc;
  securityGroup: ec2.SecurityGroup;
};

/**
 * A private network for user VMs with no way in from the internet.
 * VMs dial out to the relay, so the firewall has zero inbound rules. There is
 * no NAT gateway (about $32 a month each): VMs get public addresses for
 * outbound traffic only, and the empty firewall keeps them unreachable.
 */
export class VmNetworkStack extends cdk.Stack implements VmNetwork {
  readonly vpc: ec2.Vpc;
  readonly securityGroup: ec2.SecurityGroup;

  /**
   * Two named zones instead of the usual account lookup, so synthesis needs no
   * AWS login and CI can run it. Zones `a` and `b` exist in every region we use.
   */
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "vm", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
      // Our own firewall is used, so skip the helper that rewrites the default one.
      restrictDefaultSecurityGroup: false,
    });
    this.securityGroup = new ec2.SecurityGroup(this, "VmSecurityGroup", {
      vpc: this.vpc,
      description: "User VMs: no inbound, outbound open.",
      allowAllOutbound: true,
    });
    new cdk.CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, "SubnetIds", {
      value: this.vpc.publicSubnets.map((s) => s.subnetId).join(","),
    });
    new cdk.CfnOutput(this, "SecurityGroupId", {
      value: this.securityGroup.securityGroupId,
    });
  }
}

/**
 * The roles later tasks borrow, each limited to what that task does.
 * A user's computer gets no role of its own. The instance profiles here are for
 * the temporary machine that builds the host image (Task 4.2) and for the host
 * that runs users' computers (Task 4.5).
 */
export class VmRolesStack extends cdk.Stack {
  readonly provisionerRole: iam.Role;
  readonly hostRole: iam.Role;
  readonly imageBuilderRole: iam.Role;
  readonly schedulerRole: iam.Role;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { config: InfraConfig },
  ) {
    super(scope, id, props);
    const { config } = props;
    const ec2Arn = (resource: string) =>
      this.formatArn({ service: "ec2", resource, resourceName: "*" });
    const tagged = {
      StringEquals: { [`ec2:ResourceTag/${managedTag.key}`]: managedTag.value },
    };

    // The control plane creates each user's data volume, once, and looks it up
    // by owner. It never starts, stops or deletes anything (Task 4.5): the
    // computers run on a host, which the host agent manages.
    this.provisionerRole = new iam.Role(this, "ProvisionerRole", {
      roleName: "companion-provisioner",
      assumedBy: new iam.AccountPrincipal(config.controlPlaneAccountId),
      description:
        "Lets the control plane create users' data volumes, and nothing else.",
    });
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeVolumes"],
        resources: ["*"],
      }),
    );
    // A new volume must be encrypted and carry the managed tag, so the host's
    // role can find it and nothing else.
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateVolume"],
        resources: [ec2Arn("volume")],
        conditions: {
          StringEquals: {
            [`aws:RequestTag/${managedTag.key}`]: managedTag.value,
            "ec2:Encrypted": "true",
          },
        },
      }),
    );
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: [ec2Arn("volume")],
        conditions: { StringEquals: { "ec2:CreateAction": "CreateVolume" } },
      }),
    );

    // The host's own role: attach and detach users' data volumes, and read its
    // relay token and settings from Parameter Store. It has no other power.
    this.hostRole = new iam.Role(this, "HostRole", {
      roleName: "companion-host",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description:
        "For the microVM host only. Never reachable from a user's computer.",
    });
    this.hostRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeVolumes"],
        resources: ["*"],
      }),
    );
    this.hostRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:AttachVolume", "ec2:DetachVolume"],
        resources: [ec2Arn("volume")],
        conditions: tagged,
      }),
    );
    this.hostRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:AttachVolume", "ec2:DetachVolume"],
        resources: [ec2Arn("instance")],
        conditions: tagged,
      }),
    );
    this.hostRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: `${hostParametersPrefix.slice(1)}/*`,
          }),
        ],
      }),
    );
    new iam.CfnInstanceProfile(this, "HostProfile", {
      instanceProfileName: "companion-host",
      roles: [this.hostRole.roleName],
    });

    // The temporary machine that bakes the base image (Task 4.2).
    this.imageBuilderRole = new iam.Role(this, "ImageBuilderRole", {
      roleName: "companion-image-builder",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "For the image-build machine only, never a user VM.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "EC2InstanceProfileForImageBuilder",
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });
    new iam.CfnInstanceProfile(this, "ImageBuilderProfile", {
      instanceProfileName: "companion-image-builder",
      roles: [this.imageBuilderRole.roleName],
    });

    // EventBridge Scheduler starts a stopped VM before a job is due (Task 4.6).
    this.schedulerRole = new iam.Role(this, "SchedulerRole", {
      roleName: "companion-scheduler",
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Lets scheduled wake-ups start tagged user VMs.",
    });
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StartInstances"],
        resources: [ec2Arn("instance")],
        conditions: tagged,
      }),
    );
  }
}

/**
 * A monthly spend alarm on the whole AWS account, for the person running the
 * service. It emails at 80% and 100% of the limit and when the forecast
 * passes it. It warns only; it stops nothing and says nothing about users.
 */
export class BudgetStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { config: InfraConfig },
  ) {
    super(scope, id, props);
    const { budgetUsd, alertEmail } = props.config;
    const notify = (
      notificationType: "ACTUAL" | "FORECASTED",
      threshold: number,
    ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: {
        notificationType,
        comparisonOperator: "GREATER_THAN",
        threshold,
        thresholdType: "PERCENTAGE",
      },
      subscribers: [{ subscriptionType: "EMAIL", address: alertEmail }],
    });
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "companion-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: budgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        notify("ACTUAL", 80),
        notify("ACTUAL", 100),
        notify("FORECASTED", 100),
      ],
    });
  }
}

const imageDir = join(dirname(fileURLToPath(import.meta.url)), "../image");
/** The repo root, which the relay image is built from. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The machine image the host boots from. Image Builder starts a temporary
 * machine, runs `infra/image/install-host.sh` (Firecracker, Node, the host
 * agent at a pinned commit, the container image unpacked into the microVMs'
 * root filesystem, no Docker and no remote login), then runs `test-host.sh` on
 * a second machine and publishes the AMI only if that passes. The scripts are
 * plain shell, so they can be tried by hand first.
 */
export class VmImageStack extends cdk.Stack {
  readonly pipeline: imagebuilder.CfnImagePipeline;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { config: InfraConfig; network: VmNetwork },
  ) {
    super(scope, id, props);
    const { config, network } = props;
    const install = readFileSync(join(imageDir, "install-host.sh"), "utf8");
    const verify = readFileSync(join(imageDir, "test-host.sh"), "utf8");
    const guestInit = readFileSync(join(imageDir, "guest-init.sh"), "utf8");
    // A changed script makes a new component, because a published one is immutable.
    const tag = createHash("sha256")
      .update(install)
      .update(verify)
      .update(guestInit)
      .update(config.imageRef)
      .update(config.hostCommit)
      .digest("hex")
      .slice(0, 8);

    const component = (
      kind: "build" | "test",
      script: string,
      args: string,
    ): imagebuilder.CfnComponent =>
      new imagebuilder.CfnComponent(this, `${kind}Component`, {
        name: `companion-host-${kind}-${tag}`,
        version: "1.0.0",
        platform: "Linux",
        description: `Companion host image: ${kind}.`,
        data: [
          "schemaVersion: 1.0",
          "phases:",
          `  - name: ${kind}`,
          "    steps:",
          `      - name: ${kind}Host`,
          "        action: ExecuteBash",
          "        inputs:",
          "          commands:",
          `            - echo ${Buffer.from(script).toString("base64")} | base64 -d > /tmp/${kind}-host.sh`,
          `            - bash /tmp/${kind}-host.sh${args}`,
        ].join("\n"),
      });
    const build = component(
      "build",
      install,
      ` ${config.imageRef} ${config.hostCommit}`,
    );
    const check = component("test", verify, "");

    const recipe = new imagebuilder.CfnImageRecipe(this, "Recipe", {
      name: `companion-host-${tag}`,
      version: "1.0.0",
      parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/ubuntu-server-24-lts-x86/x.x.x`,
      components: [
        { componentArn: build.attrArn },
        { componentArn: check.attrArn },
      ],
      blockDeviceMappings: [
        {
          deviceName: "/dev/sda1",
          ebs: { volumeSize: 30, volumeType: "gp3", deleteOnTermination: true },
        },
      ],
    });
    const infrastructure = new imagebuilder.CfnInfrastructureConfiguration(
      this,
      "Infrastructure",
      {
        name: "companion-image-build",
        instanceProfileName: "companion-image-builder",
        instanceTypes: ["t3.large"],
        subnetId: network.vpc.publicSubnets[0]!.subnetId,
        securityGroupIds: [network.securityGroup.securityGroupId],
        // The build machine is deleted whether or not the build worked.
        terminateInstanceOnFailure: true,
      },
    );
    this.pipeline = new imagebuilder.CfnImagePipeline(this, "Pipeline", {
      name: "companion-host",
      imageRecipeArn: recipe.attrArn,
      infrastructureConfigurationArn: infrastructure.attrArn,
      // Run by hand. A schedule for monthly OS patches comes with Task 4.5b.
      status: "ENABLED",
      imageTestsConfiguration: { imageTestsEnabled: true, timeoutMinutes: 60 },
    });
    new cdk.CfnOutput(this, "PipelineArn", { value: this.pipeline.attrArn });
  }
}

/**
 * The one host that runs every user's microVM (scaling past one is issue #44).
 * Metadata v2 only, no inbound ports, and an instance role limited to
 * attaching tagged data volumes and reading its own settings. Nested
 * virtualization is what lets Firecracker run on an ordinary instance. The
 * relay address and where to find its token arrive as launch settings; the
 * token itself is read from Parameter Store at start, never baked in.
 */
export class VmHostStack extends cdk.Stack {
  readonly instance: ec2.CfnInstance;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & {
      config: InfraConfig & { hostAmi: string };
      network: VmNetwork;
    },
  ) {
    super(scope, id, props);
    const { config, network } = props;
    const settings = [
      `COMPANION_RELAY_URL=wss://${config.relayDomain ?? "relay.invalid"}`,
      `COMPANION_HOST_PARAMS_PREFIX=${hostParametersPrefix}`,
      "COMPANION_HOST_CAPACITY=12",
    ];
    // The settings live in a launch template because it, unlike the instance
    // resource itself, can turn on nested virtualization.
    const template = new ec2.CfnLaunchTemplate(this, "HostTemplate", {
      launchTemplateName: "companion-host",
      launchTemplateData: {
        imageId: config.hostAmi,
        instanceType: "m8i.xlarge",
        iamInstanceProfile: { name: "companion-host" },
        securityGroupIds: [network.securityGroup.securityGroupId],
        cpuOptions: { nestedVirtualization: "enabled" },
        metadataOptions: {
          httpTokens: "required",
          httpPutResponseHopLimit: 1,
          httpEndpoint: "enabled",
        },
        blockDeviceMappings: [
          {
            deviceName: "/dev/sda1",
            ebs: {
              volumeSize: 100,
              volumeType: "gp3",
              encrypted: true,
              deleteOnTermination: true,
            },
          },
        ],
        userData: cdk.Fn.base64(
          [
            "#cloud-config",
            "write_files:",
            "  - path: /etc/companion-host.env",
            '    permissions: "0600"',
            "    content: |",
            ...settings.map((line) => `      ${line}`),
            "runcmd:",
            "  - systemctl restart companion-host.service",
            "",
          ].join("\n"),
        ),
      },
    });
    this.instance = new ec2.CfnInstance(this, "Host", {
      launchTemplate: {
        launchTemplateId: template.ref,
        version: template.attrLatestVersionNumber,
      },
      subnetId: network.vpc.publicSubnets[0]!.subnetId,
      tags: [
        { key: managedTag.key, value: managedTag.value },
        { key: "Name", value: "companion-host" },
      ],
    });
    new cdk.CfnOutput(this, "HostInstanceId", { value: this.instance.ref });
    new cdk.CfnOutput(this, "HostAvailabilityZone", {
      value: this.instance.attrAvailabilityZone,
    });
  }
}

/** Builds all stacks for one config. Shared by the CDK entrypoint and the tests. */
export function buildApp(config: InfraConfig): cdk.App {
  const app = new cdk.App();
  const env = { account: config.vmAccountId, region: config.region };
  const network = new VmNetworkStack(app, "CompanionVmNetwork", { env });
  new VmRolesStack(app, "CompanionVmRoles", { env, config });
  new VmImageStack(app, "CompanionVmImage", { env, config, network });
  if (config.hostAmi !== undefined) {
    new VmHostStack(app, "CompanionVmHost", {
      env,
      config: { ...config, hostAmi: config.hostAmi },
      network,
    });
  }
  new BudgetStack(app, "CompanionBudget", { env, config });
  if (config.relayDomain !== undefined) {
    const cert = new RelayCertStack(app, "CompanionRelayCert", {
      env,
      domain: config.relayDomain,
    });
    new RelayStack(app, "CompanionRelay", {
      env,
      domain: config.relayDomain,
      certificate: cert.certificate,
      image:
        config.relayImageRef !== undefined
          ? ecs.ContainerImage.fromRegistry(config.relayImageRef)
          : ecs.ContainerImage.fromAsset(repoRoot, {
              file: "apps/relay/Dockerfile",
              platform: ecrAssets.Platform.LINUX_ARM64,
            }),
    });
  }
  return app;
}
