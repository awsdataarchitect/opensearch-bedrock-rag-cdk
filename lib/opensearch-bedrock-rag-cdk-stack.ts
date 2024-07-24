import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export class OpensearchBedrockRagCdkStack extends cdk.Stack {
  OpenSearchEndpoint: string
  VectorIndexName: string
  VectorFieldName: string
  sqs_queue_url: string
  bedrockPolicy: iam.Policy
  openSearchPolicy: iam.Policy

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Read SAML metadata XML from file
    const metadataFilePath = path.join(__dirname, '../metadata.xml');
    const samlMetadata = fs.readFileSync(metadataFilePath, 'utf-8');
    const CollectionName = 'rag-collection'
    const vectorIndexName = 'rag-vector-index'

    const secConfig = new opensearchserverless.CfnSecurityConfig(this, 'OpenSearchServerlessSecurityConfig', {
      name: `${CollectionName}-config`,
      type: 'saml',
      samlOptions: {
        metadata: samlMetadata
      }
    });

    // Define the encryption policy
    const encPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: 'rag-encryption-policy',
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/${CollectionName}`]
          }
        ],
        AWSOwnedKey: true
      }),
      type: 'encryption'
    });

    // Network policy is required so that the dashboard can be viewed!
    const netPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: 'rag-network-policy',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${CollectionName}`],
            },
            {
              ResourceType: 'dashboard',
              Resource: [`collection/${CollectionName}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
      type: 'network',
    });


    // Create the OpenSearch Serverless collection
    const collection = new opensearchserverless.CfnCollection(this, 'OpenSearchCollection', {
      name: CollectionName,
      type: 'VECTORSEARCH',
    });

    // Create Lambda function for custom resource
    const createIndexLambda = new lambda.Function(this, 'CreateIndexLambda', {
      functionName: 'CreateIndexFunction',
      role: new iam.Role(this, 'CreateIndexLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        roleName: 'CreateIndex-LambdaRole',
        // Add any additional permissions required by your function
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
        ],
        // Add any additional permissions required by your function
        inlinePolicies: {
          lambdaOpenSearchAccessPolicy: new iam.PolicyDocument({
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
                  `arn:aws:aoss:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:index/${CollectionName}/*`
                ],
                effect: iam.Effect.ALLOW,
              })
            ]
          })
        }
      }),
      handler: 'index.handler',
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/aoss'), // Path to your Lambda function code
      timeout: cdk.Duration.minutes(5),
    });

    // Define the data access policy
    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataAccessPolicy', {
      name: 'rag-data-access-policy',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${CollectionName}`],
              Permission: [
                'aoss:CreateCollectionItems',
                'aoss:DeleteCollectionItems',
                'aoss:UpdateCollectionItems',
                'aoss:DescribeCollectionItems',
              ],
            },
            {
              ResourceType: 'index',
              Resource: [`index/${CollectionName}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
              ],
            },
          ],
          Principal: [
            createIndexLambda.role?.roleArn,
            `saml/${this.account}/${CollectionName}-config/user/vivek`,
            `arn:aws:iam::${this.account}:root`,
          ],
        },
      ]),
      type: 'data',
      description: 'Data access policy for rag-collection',
    });

    // Ensure the collection depends on the policies
    collection.addDependency(dataAccessPolicy);
    collection.addDependency(encPolicy);
    collection.addDependency(netPolicy);

    const Endpoint = `${collection.attrId}.${cdk.Stack.of(this).region}.aoss.amazonaws.com`;

    const vectorIndex = new cr.AwsCustomResource(this, 'vectorIndexResource', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            CollectionName: collection.name,
            IndexName: vectorIndexName,
            Endpoint: Endpoint,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('vectorIndex'),
      },
      onDelete: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Delete',
            CollectionName: collection.name,
            IndexName: vectorIndexName,
            Endpoint: Endpoint,
          }),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [createIndexLambda.functionArn],
        }),
      ]),
      timeout: cdk.Duration.minutes(5),
    });

    // Ensure vectorIndex depends on collection
    vectorIndex.node.addDependency(collection);
    vectorIndex.node.addDependency(createIndexLambda);
    const vector_field_name= 'vector_field'

      // Create an SQS queue
      const queue = new sqs.Queue(this, 'MyQueue', {
        queueName: 'docs-queue',
        retentionPeriod: cdk.Duration.days(1),
        visibilityTimeout: cdk.Duration.seconds(30),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

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

    // Create a Lambda function
    const lambdaFunction = new lambda.Function(this, 'MyLambdaFunction', {
      functionName: 'docs-indexer',
      timeout: cdk.Duration.seconds(20),
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/indexer'),
      environment: {
        'opensearch_host': Endpoint,
        'vector_index_name': vectorIndexName,
        'vector_field_name': vector_field_name,
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

    this.OpenSearchEndpoint = Endpoint
    this.VectorIndexName = vectorIndexName
    this.VectorFieldName = vector_field_name
    this.sqs_queue_url = queue.queueArn
    this.bedrockPolicy = bedrockPolicy
    this.openSearchPolicy = openSearchPolicy
    

    new cdk.CfnOutput(this, 'aoss_env', {
      value: `export opensearch_host=${Endpoint}\nexport vector_index_name=${vectorIndexName}\nexport vector_field_name=vector_field`
    });

    new cdk.CfnOutput(this, 'sqs_queue_url', {
      value: queue.queueArn
    });

  }
}
