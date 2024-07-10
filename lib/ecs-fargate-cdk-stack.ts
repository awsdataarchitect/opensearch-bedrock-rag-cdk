import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DockerImageAsset,Platform } from 'aws-cdk-lib/aws-ecr-assets';

interface ClusterProps extends cdk.StackProps {
    OpenSearchEndpoint: string,
    VectorIndexName: string,
    VectorFieldName: string,
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
  
      
      // Build and push Docker image to ECR
      const appImageAsset = new DockerImageAsset(this, 'MyStreamlitAppImage', {
        directory: './lib/docker',
        platform: Platform.LINUX_AMD64, // Specify the x86 architecture

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
        publicLoadBalancer: true,
        assignPublicIp: true,
        circuitBreaker: { rollback: true},
        enableExecuteCommand:true  
      });

      const bedrock_iam =new iam.Policy(this, 'BedrockPermissionsPolicy', {
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
          "ssmmessages:CreateControlChannel"
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

  }
}