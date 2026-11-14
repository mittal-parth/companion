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
import * as iam from "aws-cdk-lib/aws-iam";
import * as imagebuilder from "aws-cdk-lib/aws-imagebuilder";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Construct } from "constructs";
import { type InfraConfig, managedTag } from "./config.js";

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
 * User VMs get no role of their own. The only instance profile here is for the
 * temporary machine that builds the base image (Task 4.2).
 */
export class VmRolesStack extends cdk.Stack {
  readonly provisionerRole: iam.Role;
  readonly imageBuilderRole: iam.Role;
  readonly schedulerRole: iam.Role;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { config: InfraConfig; network: VmNetwork },
  ) {
    super(scope, id, props);
    const { config, network } = props;
    const ec2Arn = (resource: string) =>
      this.formatArn({ service: "ec2", resource, resourceName: "*" });
    const tagged = {
      StringEquals: { [`ec2:ResourceTag/${managedTag.key}`]: managedTag.value },
    };

    // The control plane creates, stops, starts and deletes user VMs (Tasks 4.4, 4.5).
    this.provisionerRole = new iam.Role(this, "ProvisionerRole", {
      roleName: "companion-provisioner",
      assumedBy: new iam.AccountPrincipal(config.controlPlaneAccountId),
      description: "Lets the control plane manage user VMs, and nothing else.",
    });
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"],
        resources: ["*"],
      }),
    );
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          ...network.vpc.publicSubnets.map((s) =>
            this.formatArn({
              service: "ec2",
              resource: "subnet",
              resourceName: s.subnetId,
            }),
          ),
          this.formatArn({
            service: "ec2",
            resource: "security-group",
            resourceName: network.securityGroup.securityGroupId,
          }),
          ec2Arn("network-interface"),
          ec2Arn("volume"),
          this.formatArn({
            service: "ec2",
            account: "",
            resource: "image",
            resourceName: "*",
          }),
        ],
      }),
    );
    // A launched VM must carry the managed tag, so the other statements can find it.
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("instance")],
        conditions: {
          StringEquals: {
            [`aws:RequestTag/${managedTag.key}`]: managedTag.value,
          },
        },
      }),
    );
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: [ec2Arn("instance"), ec2Arn("volume")],
        conditions: { StringEquals: { "ec2:CreateAction": "RunInstances" } },
      }),
    );
    this.provisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:StartInstances",
          "ec2:StopInstances",
          "ec2:TerminateInstances",
        ],
        resources: [ec2Arn("instance")],
        conditions: tagged,
      }),
    );

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

/**
 * The machine image a user VM boots from, and the launch settings that make
 * every user VM safe: metadata v2 only, no instance role, the empty firewall,
 * and a separate data disk that outlives the machine.
 *
 * Image Builder starts a temporary machine, runs `infra/image/install-host.sh`
 * (Docker, no remote login, the container image pulled by digest), then runs
 * `test-host.sh` on a second machine and publishes the AMI only if that passes.
 * The scripts are plain shell, so they can be tried by hand first.
 */
export class VmImageStack extends cdk.Stack {
  readonly launchTemplate: ec2.CfnLaunchTemplate;
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
    // A changed script makes a new component, because a published one is immutable.
    const tag = createHash("sha256")
      .update(install)
      .update(verify)
      .update(config.imageRef)
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
          `  ${kind === "build" ? "build" : "test"}:`,
          "    steps:",
          `      - name: ${kind}Host`,
          "        action: ExecuteBash",
          "        inputs:",
          "          commands:",
          `            - echo ${Buffer.from(script).toString("base64")} | base64 -d > /tmp/${kind}-host.sh`,
          `            - bash /tmp/${kind}-host.sh${args}`,
        ].join("\n"),
      });
    const build = component("build", install, ` ${config.imageRef}`);
    const check = component("test", verify, "");

    const recipe = new imagebuilder.CfnImageRecipe(this, "Recipe", {
      name: `companion-host-${tag}`,
      version: "1.0.0",
      parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/ubuntu-server-24-lts-arm64/x.x.x`,
      components: [
        { componentArn: build.attrArn },
        { componentArn: check.attrArn },
      ],
      blockDeviceMappings: [
        {
          deviceName: "/dev/sda1",
          ebs: { volumeSize: 20, volumeType: "gp3", deleteOnTermination: true },
        },
      ],
    });
    const infrastructure = new imagebuilder.CfnInfrastructureConfiguration(
      this,
      "Infrastructure",
      {
        name: "companion-image-build",
        instanceProfileName: "companion-image-builder",
        instanceTypes: ["t4g.medium"],
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
      // Run by hand. A schedule for monthly OS patches comes with Task 4.5a.
      status: "ENABLED",
      imageTestsConfiguration: { imageTestsEnabled: true, timeoutMinutes: 60 },
    });

    // The settings every user VM launches with. The image id is supplied at launch.
    this.launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: "companion-user-vm",
      launchTemplateData: {
        instanceType: "t4g.medium",
        // Metadata v2 only, and one hop so a container cannot reach it either.
        metadataOptions: {
          httpTokens: "required",
          httpPutResponseHopLimit: 1,
          httpEndpoint: "enabled",
        },
        // No `iamInstanceProfile`: a user VM holds no AWS credentials.
        securityGroupIds: [network.securityGroup.securityGroupId],
        blockDeviceMappings: [
          {
            deviceName: "/dev/sda1",
            ebs: {
              volumeSize: 20,
              volumeType: "gp3",
              encrypted: true,
              deleteOnTermination: true,
            },
          },
          // The user's data. It survives the machine, so replacing the root
          // disk or the instance never loses a bot.
          {
            deviceName: "/dev/sdf",
            ebs: {
              volumeSize: 30,
              volumeType: "gp3",
              encrypted: true,
              deleteOnTermination: false,
            },
          },
        ],
        tagSpecifications: ["instance", "volume"].map((resourceType) => ({
          resourceType,
          tags: [{ key: managedTag.key, value: managedTag.value }],
        })),
      },
    });
    new cdk.CfnOutput(this, "PipelineArn", { value: this.pipeline.attrArn });
    new cdk.CfnOutput(this, "LaunchTemplateId", {
      value: this.launchTemplate.ref,
    });
  }
}

/** Builds all stacks for one config. Shared by the CDK entrypoint and the tests. */
export function buildApp(config: InfraConfig): cdk.App {
  const app = new cdk.App();
  const env = { account: config.vmAccountId, region: config.region };
  const network = new VmNetworkStack(app, "CompanionVmNetwork", { env });
  new VmRolesStack(app, "CompanionVmRoles", { env, config, network });
  new VmImageStack(app, "CompanionVmImage", { env, config, network });
  new BudgetStack(app, "CompanionBudget", { env, config });
  return app;
}
