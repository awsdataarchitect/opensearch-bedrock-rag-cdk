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
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

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
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Remove the user pool when the stack is destroyed
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

    // Create an SQS queue
    const queue = new sqs.Queue(this, 'MyQueue', {
      queueName: 'docs-queue',
      retentionPeriod: cdk.Duration.days(1),
      visibilityTimeout: cdk.Duration.seconds(30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
          'sqs_queue_url': queue.queueUrl,
        },
      },
      certificate: certificate,
      domainName: domainName,
      domainZone: hostedZone,
      publicLoadBalancer: true,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.minutes(10),
      enableExecuteCommand: true,
    });

    // Add dependencies to avoid circular dependency issues
    appService.node.addDependency(userPool);
    appService.node.addDependency(userPoolClient);
    appService.node.addDependency(userPoolDomain);

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

    const bedrockPolicy = new iam.Policy(this, 'BedrockPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "bedrock:InvokeModel*",
            "bedrock:Converse*",
          ],
          resources: [
            "arn:aws:bedrock:us-east-1::foundation-model/amazon*",
          ],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    const openSearchPolicy = new iam.Policy(this, 'OpenSearchPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'aoss:APIAccessAll',
            'aoss:DescribeIndex',
            'aoss:ReadDocument',
            'aoss:CreateIndex',
            'aoss:DeleteIndex',
            'aoss:UpdateIndex',
            'aoss:WriteDocument',
            'aoss:CreateCollectionItems',
            'aoss:DeleteCollectionItems',
            'aoss:UpdateCollectionItems',
            'aoss:DescribeCollectionItems'
          ],
          resources: [
            `arn:aws:aoss:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:collection/*`,
            `arn:aws:aoss:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:index/*`

          ],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    appService.taskDefinition.taskRole?.attachInlinePolicy(new iam.Policy(this, 'QueuePolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'sqs:SendMessage',
          ],
          resources: [queue.queueArn],
          effect: iam.Effect.ALLOW,
        }),
      ],
    })
    );

    appService.taskDefinition.taskRole?.attachInlinePolicy(bedrockPolicy);
    appService.taskDefinition.taskRole?.attachInlinePolicy(openSearchPolicy);
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

    // Create a Lambda function
    const lambdaFunction = new lambda.Function(this, 'MyLambdaFunction', {
      functionName: 'docs-indexer',
      timeout: cdk.Duration.seconds(20),
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/indexer'),
      environment: {
        'opensearch_host': props.OpenSearchEndpoint,
        'vector_index_name': props.VectorIndexName,
        'vector_field_name': props.VectorFieldName,
      },
    });

    lambdaFunction.role?.attachInlinePolicy(bedrockPolicy)
    lambdaFunction.role?.attachInlinePolicy(openSearchPolicy)
    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      resources: [queue.queueArn],
      effect: iam.Effect.ALLOW,
    }));

    // Configure the SQS queue as an event source for the Lambda function
    lambdaFunction.addEventSource(new SqsEventSource(queue));

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

    new cdk.CfnOutput(this, 'SQSQueueUrl', {
      description: 'The URL of the SQS Queue',
      value: queue.queueUrl,
    });

  }
}