import boto3
import json
import os
import sys
from pip._internal import main

main(['install', '-I', '-q','boto3','requests','opensearch-py==2.4.2', 'urllib3','--target', '/tmp/', '--no-cache-dir', '--disable-pip-version-check'])
sys.path.insert(0,'/tmp/')
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth

def handler(event, context):
    # Initialize clients
    bedrock = boto3.client('bedrock-runtime', 'us-east-1', endpoint_url='https://bedrock-runtime.us-east-1.amazonaws.com')
    credentials = boto3.Session().get_credentials()
    region = 'us-east-1'
    service = 'aoss'
    host = os.getenv('opensearch_host')
    auth = AWSV4SignerAuth(credentials, region, service)
    client = OpenSearch(
        hosts=[{'host': host, 'port': 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=False,
        ssl_show_warn=False,
        connection_class=RequestsHttpConnection,
        pool_maxsize=50
    )

    def get_embedding(body):
        modelId = 'amazon.titan-embed-text-v1'
        accept = 'application/json'
        contentType = 'application/json'
        response = bedrock.invoke_model(body=body, modelId=modelId, accept=accept, contentType=contentType)
        response_body = json.loads(response.get('body').read())
        embedding = response_body.get('embedding')
        return embedding

    def indexDoc(client, vectors, text):
        indexDocument = {
            os.getenv("vector_field_name"): vectors,
            'text': text
        }
        response = client.index(
            index=os.getenv("vector_index_name"),
            body=indexDocument,
            refresh=False
        )
        return response

    # Process each SQS message
    for record in event['Records']:
        message = json.loads(record['body'])
        exampleContent = message['content']
        exampleInput = json.dumps({"inputText": exampleContent})
        exampleVectors = get_embedding(exampleInput)
        response = indexDoc(client, exampleVectors, exampleContent)
        print(f"Indexed document: {response}")
