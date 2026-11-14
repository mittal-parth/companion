/**
 * The always-on relay in AWS: a container on ECS Fargate behind a load
 * balancer, with its own small network and a certificate for its public name.
 *
 * The relay is control-plane software, so it has its own network apart from
 * the user VMs'. It is two stacks because a certificate waits on a DNS record
 * the operator adds by hand: deploy the certificate stack, add the record, then
 * deploy the relay. Fargate is used so there is no server to patch: AWS runs
 * the container and replaces it if it stops.
 */
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

/** The port the relay container listens on, reachable only from the load balancer. */
const relayPort = 8080;

/**
 * The relay's TLS certificate, checked by DNS. The stack does not finish until
 * the validation record shown in the ACM console (or the stack events) is added
 * at the DNS provider, which is why it is deployed on its own first.
 */
export class RelayCertStack extends cdk.Stack {
  readonly certificate: acm.Certificate;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { domain: string },
  ) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domain,
      validation: acm.CertificateValidation.fromDns(),
    });
  }
}

/** What the relay stack is built from. */
export type RelayStackProps = cdk.StackProps & {
  domain: string;
  certificate: acm.ICertificate;
  image: ecs.ContainerImage;
};

/**
 * One relay task behind an internet-facing load balancer.
 * One task is deliberate at first: it holds every VM's connection, so a second
 * would need a shared message bus between them. The task's firewall accepts the
 * load balancer and nothing else.
 */
export class RelayStack extends cdk.Stack {
  /**
   * Two named zones instead of an account lookup, so synthesis needs no AWS
   * login and CI can run it.
   */
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, props: RelayStackProps) {
    super(scope, id, props);

    // Public subnets and no NAT gateway (about $32 a month): the task gets a
    // public address to pull its image and write logs, and its firewall keeps
    // it unreachable except through the load balancer.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "relay", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: false,
    });

    // The key both token kinds are signed with. It is generated here and never
    // appears in the template. The web server and the provisioner read it from
    // Secrets Manager.
    const secret = new secretsmanager.Secret(this, "RelaySecret", {
      description:
        "Signs the tokens VMs and the web server present to the relay.",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer("relay", {
      image: props.image,
      portMappings: [{ containerPort: relayPort }],
      environment: { PORT: String(relayPort) },
      secrets: { RELAY_SECRET: ecs.Secret.fromSecretsManager(secret) },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "relay",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster: new ecs.Cluster(this, "Cluster", { vpc }),
      taskDefinition,
      desiredCount: 1,
      // A deploy starts the new task before stopping the old one, so VMs
      // reconnect to a task that is already up.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // A task that cannot start fails the deploy within minutes and rolls back.
      circuitBreaker: { rollback: true },
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      healthCheckGracePeriod: cdk.Duration.seconds(30),
    });

    const balancer = new elbv2.ApplicationLoadBalancer(this, "Balancer", {
      vpc,
      internetFacing: true,
      // A streamed turn can be quiet for minutes, and VMs hold their socket
      // for days. The default of 60 seconds would cut both.
      idleTimeout: cdk.Duration.seconds(3600),
    });
    balancer
      .addListener("Https", {
        port: 443,
        certificates: [props.certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      })
      .addTargets("Relay", {
        port: relayPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: { path: "/health" },
        // A replaced task stops taking requests quickly, so a deploy is short.
        deregistrationDelay: cdk.Duration.seconds(30),
      });
    balancer.addRedirect({
      sourcePort: 80,
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      targetPort: 443,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
    });

    new cdk.CfnOutput(this, "RelayUrl", { value: `https://${props.domain}` });
    new cdk.CfnOutput(this, "PointDnsAt", {
      description: `Add a DNS-only CNAME from ${props.domain} to this name.`,
      value: balancer.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, "SecretArn", { value: secret.secretArn });
  }
}
