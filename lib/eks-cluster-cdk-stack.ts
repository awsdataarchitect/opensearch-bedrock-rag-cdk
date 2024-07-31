import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as blueprints from '@aws-quickstart/eks-blueprints';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Lazy } from 'aws-cdk-lib';
import { LookupHostedZoneProvider, GlobalResources } from '@aws-quickstart/eks-blueprints';

interface ClusterProps extends cdk.StackProps {
  OpenSearchEndpoint: string;
  VectorIndexName: string;
  VectorFieldName: string;
  domainName: string,
  sqs_queue_url: string,
  sqs_queue_arn: string,
  bedrockPolicy: iam.Policy,
  openSearchPolicy: iam.Policy,
  userPool: cdk.aws_cognito.IUserPool,
  userPoolClient: cdk.aws_cognito.IUserPoolClient,
  userPoolDomain: cdk.aws_cognito.IUserPoolDomain,
  acmCertificate: cdk.aws_certificatemanager.ICertificate,
  DOCKER_CONTAINER_PLATFORM_ARCH: string,
  MASTERS_ROLE_ARN: string,
  USER_ROLE_ARN: string,
}

export class EksClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id, props);

    const mastersRoleArn = props.MASTERS_ROLE_ARN;
    const userRoleArn = props.USER_ROLE_ARN;
    const dockerPlatform = props.DOCKER_CONTAINER_PLATFORM_ARCH;
    console.log(`Docker Platform: ${dockerPlatform}`);

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

    // Get the public subnets
    const publicSubnets = vpc.publicSubnets;

    // Apply tags to the public subnets
    publicSubnets.forEach((subnet, index) => {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
      // Add other tags as needed
    });

    // Build and push Docker image to ECR
    const appImageAsset = new DockerImageAsset(this, 'MyStreamlitAppImage', {
      directory: './lib/docker',
      platform: dockerPlatform == "arm" ? Platform.LINUX_ARM64 : Platform.LINUX_AMD64
    });

    const addOns: Array<blueprints.ClusterAddOn> = [
      new blueprints.addons.AwsLoadBalancerControllerAddOn(),
      new blueprints.addons.VpcCniAddOn(),
      new blueprints.ExternalDnsAddOn({
        hostedZoneResources: [GlobalResources.HostedZone]
      }),
      new StreamlitAppManifests(appImageAsset.imageUri, props.OpenSearchEndpoint, props.VectorIndexName, props.VectorFieldName,
        props.sqs_queue_url, props.userPool.userPoolArn, props.userPoolClient.userPoolClientId, props.domainName, props.userPoolDomain.domainName, props.acmCertificate.certificateArn
      )
    ];

    const clusterProvider = new blueprints.GenericClusterProvider({
      version: eks.KubernetesVersion.of('1.30'),
      tags: { 'Name': 'bedrock-eks-cluster' },
      mastersRole: blueprints.getResource(context => {
        return iam.Role.fromRoleArn(context.scope, 'MastersRole', mastersRoleArn, {
          mutable: true, // Set to true if you need to update the role
        })
      }),
      managedNodeGroups: [{
        id: 'mng1',
        instanceTypes: [new ec2.InstanceType(dockerPlatform == "arm" ? 't4g.medium': 't3.medium')],
        amiType:  dockerPlatform == "arm" ? eks.NodegroupAmiType.AL2_ARM_64 : eks.NodegroupAmiType.AL2_X86_64,
        nodeGroupCapacityType: eks.CapacityType.SPOT,
        nodeRole:
          blueprints.getResource(
            context => new iam.Role(context.scope, 'eks-node-role', {
              roleName: 'bedrock-eks-node-role',
              assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
              managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
              ],
              inlinePolicies: {
                bedrockPolicy: props.bedrockPolicy.document,
                openSearchPolicy: props.openSearchPolicy.document,
                sqspolicy: new iam.PolicyDocument({
                  statements: [
                    new iam.PolicyStatement({
                      actions: ['sqs:SendMessage'],
                      resources: [
                        Lazy.string({ produce: () => `${props.sqs_queue_arn}` }),
                      ],
                      effect: iam.Effect.ALLOW,
                    }),
                  ],
                }),
              }
            })
          ),
        desiredSize: 1,
        minSize: 0,
        maxSize: 1,
        nodeGroupSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      }],
      privateCluster: false,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
      role: blueprints.getResource(context => {
        return new iam.Role(context.scope, 'AdminRole', {
          roleName: 'bedrock-eks-AdminRole',
          assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
          ],
        });
      }),
    });

    const platformTeam = new blueprints.PlatformTeam({
      name: 'platform-admin',
      userRoleArn: userRoleArn,
    });

    blueprints.EksBlueprint.builder()
      .region(process.env.CDK_DEFAULT_REGION)
      .addOns(...addOns)
      .clusterProvider(clusterProvider)
      .teams(platformTeam)
      .resourceProvider(GlobalResources.HostedZone, new LookupHostedZoneProvider(props.domainName))
      .resourceProvider(blueprints.GlobalResources.Vpc,
        new blueprints.DirectVpcProvider(vpc))
      .build(this, 'bedrock-eks-cluster')
  }
}

class StreamlitAppManifests implements blueprints.ClusterAddOn {
  private readonly imageUri: string;
  private readonly opensearchHost: string;
  private readonly vectorIndexName: string;
  private readonly vectorFieldName: string;
  private readonly sqs_queue_url: string;
  private readonly userPoolArn: string;
  private readonly userPoolClientId: string;
  private readonly userPoolDomain: string;
  private readonly acmCertificate: string;
  private readonly domainName: string;

  constructor(imageUri: string, opensearchHost: string, vectorIndexName: string, vectorFieldName: string,
    sqs_queue_url: string, userPoolArn: string, userPoolClientId: string, domainName: string, userPoolDomain: string, acmCertificate: string
  ) {
    this.imageUri = imageUri;
    this.opensearchHost = opensearchHost;
    this.vectorIndexName = vectorIndexName;
    this.vectorFieldName = vectorFieldName;
    this.sqs_queue_url = sqs_queue_url
    this.userPoolArn = userPoolArn;
    this.userPoolClientId = userPoolClientId;
    this.userPoolDomain = userPoolDomain;
    this.acmCertificate = acmCertificate;
    this.domainName = domainName;
  }

  deploy(clusterInfo: blueprints.ClusterInfo): void {
    const cluster = clusterInfo.cluster;

    // Inline YAML manifest for Deployment
    const deploymentManifest = `---
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: rag-deployment
    spec:
      replicas: 2
      selector:
        matchLabels:
          app: rag-app
      template:
        metadata:
          labels:
            app: rag-app
        spec:
          containers:
          - name: rag-container
            image: ${this.imageUri}
            env:
            - name: opensearch_host
              value: ${this.opensearchHost}
            - name: vector_index_name
              value: ${this.vectorIndexName}
            - name: vector_field_name
              value: ${this.vectorFieldName}
            - name: sqs_queue_url
              value: ${this.sqs_queue_url}
            ports:
            - containerPort: 8501
    `;
    let manifest = deploymentManifest.split("---").map(e => blueprints.utils.loadYaml(e));

    new eks.KubernetesManifest(cluster.stack, "deployment-manifest", {
      cluster,
      manifest,
      overwrite: true
    });

    // Inline YAML manifest for Service
    const serviceManifest = `---
    apiVersion: v1
    kind: Service
    metadata:
      name: rag-service
    spec:
      selector:
        app: rag-app
      ports:
        - protocol: TCP
          port: 443
          targetPort: 8501  
      type: NodePort
    `;

    manifest = serviceManifest.split("---").map(e => blueprints.utils.loadYaml(e));

    new eks.KubernetesManifest(cluster.stack, "service-manifest", {
      cluster,
      manifest,
      overwrite: true
    });

    const ingress = cluster.addManifest('ingress', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'rag-ingress',
        annotations: {
          'alb.ingress.kubernetes.io/scheme': 'internet-facing',
          'alb.ingress.kubernetes.io/target-type': 'ip',
          'alb.ingress.kubernetes.io/auth-type': 'cognito',
          'alb.ingress.kubernetes.io/certificate-arn': this.acmCertificate,
          'alb.ingress.kubernetes.io/auth-idp-cognito': JSON.stringify({
            userPoolArn: this.userPoolArn,
            userPoolClientId: this.userPoolClientId,
            userPoolDomain: this.userPoolDomain,
          }),
          //'alb.ingress.kubernetes.io/auth-session-timeout': '3600',
          //'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP": 80}, {"HTTPS":443}]',  
          //'alb.ingress.kubernetes.io/auth-session-cookie': 'AWSELBAuthSessionCookie',
          //'alb.ingress.kubernetes.io/auth-on-unauthenticated-request': 'authenticate',
        },
      },
      spec: {
        ingressClassName: 'alb',
        rules: [
          {
            host: `${this.domainName}`,
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: 'rag-service',
                      port: { number: 443 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
  }
}