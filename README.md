# Open-source repo with demo of Generative AI RAG solution using Amazon Bedrock and OpenSearch Serverless - Using the Well-Architected Machine Learning Lens PDF to prepare for the AWS Machine Learning Engineer Associate (MLS-C01) Certification Exam

This is a CDK project written in TypeScript to demo how to implement a RAG solution using Amazon Bedrock and Amazon OpenSearch Serverless

#  Architecture Diagram
![Alt text](./bedrock-aoss-rag.png?raw=true "RAG Solution using Amazon Bedrock and AOSS (Amazon OpenSearch Serverless)")

For more details on how to deploy the infrastructure and the solution details, please refer to the Blog Posts:
* [Part 1: Build the Amazon OpenSearch Serverless Vector Db using AWS-CDK](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-1-build-theamazon-opensearch-serverless-vector-db-using-1656663a302b).
* [Part 2: Build the MCQ orchestrator using Bedrock Converse API](https://vivek-aws.medium.com/rag-solution-using-amazon-bedrock-part-2-build-the-mcq-orchestrator-using-bedrock-converse-api-61c2b2ce3f20).

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
