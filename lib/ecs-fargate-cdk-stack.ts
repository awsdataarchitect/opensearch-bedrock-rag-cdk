import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Lazy } from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';

interface ClusterProps extends cdk.StackProps {
  OpenSearchEndpoint: string,
  VectorIndexName: string,
  VectorFieldName: string,
}

export class EcsFargateCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id, props);

    // Read configuration from config.ini file
    const configPath = path.resolve(__dirname, '../config.ini');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: Record<string, string> = {};
    configContent.split('\n').forEach((line) => {
      const [key, value] = line.split('=');
      if (key && value) {
        config[key.trim()] = value.trim();
      }
    });

    const domainName = config['domainName'];
    const hostedZoneId = config['hostedZoneId'];

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

    // Build and push Docker image to ECR
    const appImageAsset = new DockerImageAsset(this, 'MyStreamlitAppImage', {
      directory: './lib/docker',
      platform: Platform.LINUX_AMD64, // Specify the x86 architecture

    });

    // Create a Cognito User Pool
    const userPool = new cognito.UserPool(this, 'MyUserPool', {
      userPoolName: 'rag-demo-pool',
      selfSignUpEnabled: true, // Enable self sign-up
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      signInAliases: { email: true }, // Set email as an alias
      autoVerify: { email: true },
    });

    const userPoolDomain = new cognito.UserPoolDomain(this, 'MyUserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: 'rag-demo', // Choose a unique domain prefix
      },
    });

    // Construct the logout URL
    const redirectUri = encodeURIComponent(`https://${domainName}`);


    // Create a Cognito User Pool Client
    const userPoolClient = userPool.addClient('MyUserPoolClient', {
      userPoolClientName: 'rag-demo-client',
      idTokenValidity: cdk.Duration.days(1),
      accessTokenValidity: cdk.Duration.days(1),
      generateSecret: true,
      oAuth: {
        callbackUrls: [
          Lazy.string({ produce: () => `https://${domainName}/oauth2/idpresponse` }),
          Lazy.string({ produce: () => `https://${domainName}` }),
        ],
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    const hostedZone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(this, 'hosted-zone', {
      hostedZoneId: hostedZoneId,
      zoneName: domainName,
    });

    // Create an SSL certificate
    const certificate = new acm.Certificate(this, 'MyCertificate', {
      domainName: domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone), // Validate the certificate using DNS
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
        },
      },
      certificate: certificate,
      domainName: domainName,
      domainZone: hostedZone,
      publicLoadBalancer: true,
      assignPublicIp: true,
      circuitBreaker: { rollback: false },//disable rollback
      enableExecuteCommand: true,
    });

    // Add dependencies to avoid circular dependency issues
    appService.node.addDependency(userPool);
    appService.node.addDependency(userPoolClient);
    appService.node.addDependency(userPoolDomain);


    const lbSecurityGroup = appService.loadBalancer.connections.securityGroups[0];
    lbSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Outbound HTTPS traffic to get to Cognito'
    );

    appService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '10');

    appService.listener.addAction('authenticate-rule', {
      priority: 1000,
      action: new cdk.aws_elasticloadbalancingv2_actions.AuthenticateCognitoAction({
        next: elbv2.ListenerAction.forward([appService.targetGroup]),
        userPool: userPool,
        userPoolClient: userPoolClient,
        userPoolDomain: userPoolDomain,
      }),
      conditions: [elbv2.ListenerCondition.hostHeaders([domainName])],
    });

    const cfnListener = appService.listener.node.defaultChild as elbv2.CfnListener;
    cfnListener.defaultActions = [{
      type: 'fixed-response',
      fixedResponseConfig: {
        statusCode: '403',
        contentType: 'text/plain',
        messageBody: 'This is not a valid endpoint!',
      },
    }];


    const bedrock_iam = new iam.Policy(this, 'BedrockPermissionsPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            // Add Bedrock permissions here
            "bedrock:InvokeModel*",
            "bedrock:Converse*",
            "aoss:*"
          ],
          resources: [
            "arn:aws:bedrock:us-east-1::foundation-model/amazon*",
            "*"
          ], // Adjust the resource as needed
        }),
      ],
    })

    appService.taskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:CreateControlChannel",
      ],
      resources: ["*"] //adjust as per your need
    }));

    // Add the Bedrock permissions to the task role
    appService.taskDefinition.taskRole?.attachInlinePolicy(bedrock_iam)

    // Grant ECR repository permissions for the task execution role
    appImageAsset.repository.grantPullPush(appService.taskDefinition.executionRole!);

    // Grant permissions for CloudWatch Logs
    const logGroup = new logs.LogGroup(this, 'MyLogGroup', {
      logGroupName: '/ecs/ecs-bedrock-service',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    logGroup.grantWrite(appService.taskDefinition.executionRole!);

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      description: 'The ID of the Cognito User Pool',
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      description: 'The ID of the Cognito User Pool Client',
      value: userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, 'UserPoolDomainName', {
      description: 'The domain name of the Cognito User Pool Domain',
      value: userPoolDomain.domainName,
    });

  }
}