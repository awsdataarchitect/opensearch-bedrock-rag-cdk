#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OpensearchBedrockRagCdkStack } from '../lib/opensearch-bedrock-rag-cdk-stack';
import { EcsFargateCdkStack } from '../lib/ecs-fargate-cdk-stack';

const app = new cdk.App();
const openSearchStack = new OpensearchBedrockRagCdkStack(app, 'OpensearchBedrockRagCdkStack', {
});

new EcsFargateCdkStack(app, 'EcsFargateCdkStack', {
  OpenSearchEndpoint: openSearchStack.OpenSearchEndpoint,
  VectorFieldName:    openSearchStack.VectorFieldName,
  VectorIndexName:    openSearchStack.VectorIndexName
});