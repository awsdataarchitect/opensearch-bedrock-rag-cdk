import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

interface ClusterProps extends cdk.StackProps {
  OpenSearchEndpoint: string,
  VectorIndexName: string,
  VectorFieldName: string,
  domainName: string,
  sqs_queue_url: string,
  sqs_queue_arn: string,
  bedrockPolicy: iam.Policy,
  openSearchPolicy: iam.Policy,
  userPool: cdk.aws_cognito.IUserPool,
  userPoolClient: cdk.aws_cognito.IUserPoolClient,
  userPoolDomain: cdk.aws_cognito.IUserPoolDomain,
  acmCertificate: cdk.aws_certificatemanager.ICertificate,
  DOCKER_CONTAINER_PLATFORM_ARCH: string
}

export class EcsFargateCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id, props);

    // Create a VPC with public subnets only and 2 max availability zones
    const vpc = new ec2.Vpc(this, 'MyVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Create an ECS Cluster named "bedrock-ecs-cluster"
    const cluster = new ecs.Cluster(this, 'MyEcsCluster', {
      vpc,
      clusterName: 'bedrock-ecs-cluster',
    });

    const dockerPlatform = props.DOCKER_CONTAINER_PLATFORM_ARCH
    console.log(`Docker Platform: ${dockerPlatform}`);

    // Build and push Docker image to ECR
    const appImageAsset = new DockerImageAsset(this, 'MyStreamlitAppImage', {
      directory: './lib/docker',
      platform: dockerPlatform == "arm" ? Platform.LINUX_ARM64 : Platform.LINUX_AMD64
    });

    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(this, 'ImportedHostedZone', {
      domainName: props.domainName,
    });

    // Create a new Fargate service with the image from ECR and specify the service name
    const appService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'MyFargateService', {
      cluster,
      serviceName: 'ecs-bedrock-service',
      taskImageOptions: {
        image: ecs.ContainerImage.fromDockerImageAsset(appImageAsset),
        containerPort: 8501,
        environment: {
          'opensearch_host': props.OpenSearchEndpoint,
          'vector_index_name': props.VectorIndexName,
          'vector_field_name': props.VectorFieldName,
          'sqs_queue_url': props.sqs_queue_url,
        },
      },
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: dockerPlatform == "arm" ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64
      },
      certificate: props.acmCertificate,
      domainName: props.domainName,
      domainZone: hostedZone,
      publicLoadBalancer: true,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(50),
      enableExecuteCommand: true,
    });

    const lbSecurityGroup = new ec2.SecurityGroup(this, 'LbSecurityGroup', {
      vpc,
      description: 'Allow only necessary traffic to the Load Balancer',
      allowAllOutbound: true,
    });

    lbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from anywhere'
    );

    appService.loadBalancer.connections.addSecurityGroup(lbSecurityGroup);

    appService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '10');

    // Check if the properties are defined before creating the action
    if (props.userPool && props.userPoolClient && props.userPoolDomain) {
      appService.listener.addAction('authenticate-rule', {
        priority: 1000,
        action: new cdk.aws_elasticloadbalancingv2_actions.AuthenticateCognitoAction({
          next: elbv2.ListenerAction.forward([appService.targetGroup]),
          userPool: props.userPool,
          userPoolClient: props.userPoolClient,
          userPoolDomain: props.userPoolDomain,
        }),
        conditions: [elbv2.ListenerCondition.hostHeaders([props.domainName])],
      });
    }

    const cfnListener = appService.listener.node.defaultChild as elbv2.CfnListener;
    cfnListener.defaultActions = [{
      type: 'fixed-response',
      fixedResponseConfig: {
        statusCode: '403',
        contentType: 'text/plain',
        messageBody: 'This is not a valid endpoint!',
      },
    }];

    appService.taskDefinition.taskRole?.attachInlinePolicy(new iam.Policy(this, 'QueuePolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'sqs:SendMessage',
          ],
          resources: [props.sqs_queue_arn],
          effect: iam.Effect.ALLOW,
        }),
      ],
    })
    );

    const bedrockPolicyecs = new iam.Policy(this, 'bedrockPolicyecs', {
      document: props.bedrockPolicy.document,
    });

    const opensearchPolicyecs = new iam.Policy(this, 'opensearchPolicyecs', {
      document: props.openSearchPolicy.document,
    });

    appService.taskDefinition.taskRole?.attachInlinePolicy(bedrockPolicyecs);
    appService.taskDefinition.taskRole?.attachInlinePolicy(opensearchPolicyecs);
    appService.taskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:CreateControlChannel",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: ["*"] //adjust as per your need
    }));

    // Grant ECR repository permissions for the task execution role
    appImageAsset.repository.grantPullPush(appService.taskDefinition.executionRole!);

    // Grant permissions for CloudWatch Logs
    const logGroup = new logs.LogGroup(this, 'MyLogGroup', {
      logGroupName: '/ecs/ecs-bedrock-service',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    logGroup.grantWrite(appService.taskDefinition.executionRole!);

  }
}