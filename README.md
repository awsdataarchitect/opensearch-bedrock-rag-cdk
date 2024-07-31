# Open-source repo with demo of Generative AI RAG solution using Amazon Bedrock and OpenSearch Serverless - Using the Well-Architected Machine Learning Lens PDF to prepare for the AWS Machine Learning Engineer Associate (MLA-C01) Certification Exam

This is a CDK project written in TypeScript to demo how to implement a RAG solution using Amazon Bedrock and Amazon OpenSearch Serverless

#  Architecture Diagram: RAG Solution using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless)
![Alt text](./bedrock-aoss-rag.png?raw=true "RAG Solution using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless)")

For more details on how to deploy the infrastructure and the solution details, please refer to the Blog Posts:
* [Part 1: Build the Amazon OpenSearch Serverless Vector Db using AWS-CDK](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-1-build-theamazon-opensearch-serverless-vector-db-using-1656663a302b).
* [Part 2: Build the MCQ orchestrator using Bedrock Converse API](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-2-build-the-mcq-orchestrator-using-bedrock-converse-api-61c2b2ce3f20).

#  Architecture Diagram: RAG App using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on ECS Fargate
![Alt text](./bedrock-ecs-aoss-rag.png?raw=true "RAG App using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on ECS Fargate")
* [Part 3: Automating Application Setup with ECS Fargate, Bedrock, and OpenSearch Serverless](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-3-automating-application-setup-with-ecs-fargate-bedrock-b3a55af9f0a4).

#  Architecture Diagram: RAG App with Cognito Authenitcation using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on ECS Fargate
![Alt text](./bedrock-ecs-cognito-aoss-rag.png?raw=true "RAG App with Cognito Authenitcation using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on ECS Fargate")
* [Part 4: Integrating Cognito Authentication with ECS Fargate, Bedrock, and OpenSearch Serverless](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-3-automating-application-setup-with-ecs-fargate-bedrock-b3a55af9f0a4).
* [Part 5: Enhancing Security Posture of the GenAI Application](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-5-enhancing-security-posture-of-the-genai-application-27c8376597a5).

#  Architecture Diagram: Event-Driven Document Indexing RAG App with Cognito Authenitcation using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on ECS Fargate
![Alt text](./bedrock-ecs-sqs-lambda-cognito-aoss-rag.png?raw=true "Event-Driven Document Indexing RAG App with Cognito Authenitcation using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on ECS Fargate")
* [Part 6: Enhancing Document Indexing with Event-Driven Architecture for a GenAI Application](https://medium.com/@vivek-aws/rag-solution-using-amazon-bedrock-part-6-enhancing-document-indexing-with-event-driven-770eaf167a0a).

* [Part 7: Deploying on Amazon EKS](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-7-deploying-on-amazon-eks-bae8a56c0ba1).

#  Architecture Diagram: Event-Driven Document Indexing RAG App with Cognito Authenitcation using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on EKS Cluster
![Alt text](./bedrock-eks-sqs-lambda-cognito-aoss-rag.png?raw=true "Event-Driven Document Indexing RAG App with Cognito Authenitcation using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless) running on EKS Cluster")
* [Part 8: Integrating Amazon Cognito with Amazon EKS](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-8-integrating-amazon-cognito-with-amazon-eks-605b3982f8c2).

* [Part 9: Optimizing ECS and EKS Infrastructure with AWS Graviton](https://vivek-aws.medium.com/rag-solution-on-amazon-bedrock-part-9-optimizing-ecs-and-eks-infra-with-aws-graviton-897353d96390).


The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
