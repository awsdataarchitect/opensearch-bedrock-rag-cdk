import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Lazy } from 'aws-cdk-lib';

interface ClusterProps extends cdk.StackProps {
    domainName: string,
  }
  
export class CognitoStack extends cdk.Stack {
  public readonly cognitoUserPool: cognito.UserPool;
  public readonly cognitoUserPoolClient: cognito.UserPoolClient;
  public readonly cognitoUserPoolDomain: cognito.UserPoolDomain;
  public readonly acmCertificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id, props);

    const domainName = props.domainName;

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

    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(this, 'ImportedHostedZone', {
      domainName: domainName,
    });

    // Create an SSL certificate
    const certificate = new acm.Certificate(this, 'MyCertificate', {
      domainName: domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone), // Validate the certificate using DNS
    });

    this.cognitoUserPool = userPool;
    this.cognitoUserPoolClient = userPoolClient;  
    this.cognitoUserPoolDomain = userPoolDomain;
    this.acmCertificate = certificate

  }
}
