import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as blueprints from '@aws-quickstart/eks-blueprints';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Lazy } from 'aws-cdk-lib';

interface ClusterProps extends cdk.StackProps {
  OpenSearchEndpoint: string;
  VectorIndexName: string;
  VectorFieldName: string;
  domainName: string,
  hostedZoneId: string,
  sqs_queue_url: string,
  bedrockPolicy: iam.Policy,
  openSearchPolicy: iam.Policy
}

export class EksClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id, props);

    const mastersRoleArn = process.env.MASTERS_ROLE_ARN || 'arn:aws:iam::1234567890:role/mastersRoleArn';
    const userRoleArn = process.env.USER_ROLE_ARN //|| 'arn:aws:iam::1234567890:role/userRoleArn';
    //const workerSpotInstanceType = 't4g.medium';
    const workerSpotInstanceType = 't3.medium';

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
      platform: Platform.LINUX_AMD64, // Specify the x86 architecture
    });

    const addOns: Array<blueprints.ClusterAddOn> = [
      new blueprints.addons.AwsLoadBalancerControllerAddOn(),
      new blueprints.addons.VpcCniAddOn(),
      new StreamlitAppManifests(appImageAsset.imageUri, props.OpenSearchEndpoint, props.VectorIndexName, props.VectorFieldName,
        props.sqs_queue_url
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
        instanceTypes: [new ec2.InstanceType(workerSpotInstanceType)],
        //amiType: eks.NodegroupAmiType.AL2_ARM_64,
        amiType: eks.NodegroupAmiType.AL2_X86_64,
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
                        Lazy.string({ produce: () => `${props.sqs_queue_url}` }),
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

  constructor(imageUri: string, opensearchHost: string, vectorIndexName: string, vectorFieldName: string,
    sqs_queue_url: string
  ) {
    this.imageUri = imageUri;
    this.opensearchHost = opensearchHost;
    this.vectorIndexName = vectorIndexName;
    this.vectorFieldName = vectorFieldName;
    this.sqs_queue_url = sqs_queue_url
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
          port: 80
          targetPort: 8501
      type: NodePort
    `;

    manifest = serviceManifest.split("---").map(e => blueprints.utils.loadYaml(e));

    new eks.KubernetesManifest(cluster.stack, "service-manifest", {
      cluster,
      manifest,
      overwrite: true
    });

    // Inline YAML manifest for Ingress
    const ingressManifest = `---
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      name: rag-ingress
      namespace: default
      annotations:
        alb.ingress.kubernetes.io/scheme: internet-facing
    spec:
      ingressClassName: alb
      rules:
        - http:
            paths:
              - path: /
                pathType: Prefix
                backend:
                  service:
                    name: rag-service
                    port:
                      number: 80
    `;

    manifest = ingressManifest.split("---").map(e => blueprints.utils.loadYaml(e));

    new eks.KubernetesManifest(cluster.stack, "ingress-manifest", {
      cluster,
      manifest,
      overwrite: true
    });
  }
}