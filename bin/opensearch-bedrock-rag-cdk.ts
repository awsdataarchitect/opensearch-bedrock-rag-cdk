import * as cdk from 'aws-cdk-lib';
import { OpensearchBedrockRagCdkStack } from '../lib/opensearch-bedrock-rag-cdk-stack';
import { EcsFargateCdkStack } from '../lib/ecs-fargate-cdk-stack';
import { EksClusterStack } from '../lib/eks-cluster-cdk-stack';
import { CognitoStack } from '../lib/cognito-cdk-stack';
import * as path from 'path';
import * as fs from 'fs';
import { BudgetTerminationAspect } from '../lib/budget-cost-aware-aspect';

const configPath = path.resolve(__dirname, '../config.ini');
const configContent = fs.readFileSync(configPath, 'utf-8');
const config: Record<string, string> = {};
configContent.split('\n').forEach((line) => {
    const [key, value] = line.split('=');
    if (key && value) {
        config[key.trim()] = value.trim();
    }
});
const budgetName = 'rag_budget'; // Set your budget name
const thresholdAmount = 5 // Set your budget threshold amount in dollars

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

let cognitoStack: CognitoStack | undefined;

if (cognito) {
    cognitoStack = new CognitoStack(app, 'CognitoStack', {
        ...props
    });
    cognitoStack.node.addDependency(openSearchStack);
}

const cognitoStackProps = cognitoStack ? {
    userPool: cognitoStack.cognitoUserPool,
    userPoolClient: cognitoStack.cognitoUserPoolClient,
    userPoolDomain: cognitoStack.cognitoUserPoolDomain,
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

cdk.Aspects.of(app).add(new BudgetTerminationAspect(budgetName, thresholdAmount));