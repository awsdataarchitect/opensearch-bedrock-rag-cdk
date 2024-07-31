#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OpensearchBedrockRagCdkStack } from '../lib/opensearch-bedrock-rag-cdk-stack';
import { EcsFargateCdkStack } from '../lib/ecs-fargate-cdk-stack';
import { EksClusterStack } from '../lib/eks-cluster-cdk-stack';
import { CognitoStack } from '../lib/cognito-cdk-stack'
import * as path from 'path';
import * as fs from 'fs';

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

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}

const app = new cdk.App();

const domainName = config['domainName'];
const targetPlatform = config['targetPlatform'];
const cognito = config['cognito'] === 'true' ? true : false;
const DOCKER_CONTAINER_PLATFORM_ARCH = config['DOCKER_CONTAINER_PLATFORM_ARCH'];
const MASTERS_ROLE_ARN = config['MASTERS_ROLE_ARN'];
const USER_ROLE_ARN = config['USER_ROLE_ARN'];

const openSearchStack = new OpensearchBedrockRagCdkStack(app, 'OpensearchBedrockRagCdkStack', {
  env: env,
});

const props = {
  OpenSearchEndpoint: openSearchStack.OpenSearchEndpoint,
  VectorIndexName: openSearchStack.VectorIndexName,
  VectorFieldName: openSearchStack.VectorFieldName,
  bedrockPolicy: openSearchStack.bedrockPolicy,
  openSearchPolicy: openSearchStack.openSearchPolicy,
  sqs_queue_url: openSearchStack.sqs_queue_url,
  sqs_queue_arn: openSearchStack.sqs_queue_arn,
  domainName: domainName,
  DOCKER_CONTAINER_PLATFORM_ARCH: DOCKER_CONTAINER_PLATFORM_ARCH,
  MASTERS_ROLE_ARN: MASTERS_ROLE_ARN,
  USER_ROLE_ARN: USER_ROLE_ARN,
  env: env,
}

let cognitoStack: CognitoStack | any;

if (cognito) {
   cognitoStack = new CognitoStack(app, 'CognitoStack', {
    ...props
  });
  cognitoStack.node.addDependency(openSearchStack);
}

// Define `cognitoStackProps` based on whether `cognitoStack` is defined
const cognitoStackProps = cognitoStack ? {
  userPool: cognitoStack.cognitoUserPool,
  userPoolClient: cognitoStack.cognitoUserPoolClient,
  userPoolDomain: cognitoStack.cognitoUserPoolDomain,
  //userPoolDomain: cdk.aws_cognito.UserPoolDomain.fromDomainName(app, 'MyUserPoolDomain', cognitoStack.cognitoUserPoolDomain.domainName),
  //userPoolDomain: cognitoStack.node.tryGetContext('MyUserPoolDomain') as cdk.aws_cognito.IUserPoolDomain,
  //userPoolDomain: cognitoStack.node.tryFindChild('MyUserPoolDomain') as cdk.aws_cognito.IUserPoolDomain,
  acmCertificate: cognitoStack.acmCertificate,
} : {};

if (targetPlatform === 'ecs') {
  const ecsFargateCdkStack = new EcsFargateCdkStack(app, 'EcsFargateCdkStack', {
    ...props,
    ...(cognitoStackProps as any),
  });
  ecsFargateCdkStack.addDependency(openSearchStack);
  if (cognitoStack) {
    ecsFargateCdkStack.node.addDependency(cognitoStack);
  }
} else if (targetPlatform === 'eks') {
  const eksClusterStack = new EksClusterStack(app, 'EksClusterCdkStack', {
    ...props,
    ...(cognitoStackProps as any),
  });
  eksClusterStack.addDependency(openSearchStack);
  if (cognitoStack) {
    eksClusterStack.node.addDependency(cognitoStack);
  }
}