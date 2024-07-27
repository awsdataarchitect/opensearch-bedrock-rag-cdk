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
const hostedZoneId = config['hostedZoneId'];
const targetPlatform = config['targetPlatform'];

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
  hostedZoneId: hostedZoneId,
  env: env,
}


if (targetPlatform === 'ecs') {
  new EcsFargateCdkStack(app, 'EcsFargateCdkStack', {
    ...props,
  });

} else if (targetPlatform === 'eks') {
  const cognitoStack = new CognitoStack(app, 'CognitoStack', {
    ...props
  });
  new EksClusterStack(app, 'EksClusterCdkStack', {
    ...props,
    userPoolClientId: cognitoStack.cognitoUserPoolClient.userPoolClientId,
    userPoolArn: cognitoStack.cognitoUserPool.userPoolArn,
    acmCertificate: cognitoStack.acmCertificate,
    userPoolDomain: cognitoStack.cognitoUserPoolDomain,
  });

}