import boto3
import json
from dotenv import load_dotenv
import os
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth

# loading in variables from .env file
load_dotenv()

# instantiating the Bedrock client, and passing in the CLI profile
boto3.setup_default_session(profile_name=os.getenv('profile_name'))
bedrock = boto3.client('bedrock-runtime', 'us-east-1', endpoint_url='https://bedrock-runtime.us-east-1.amazonaws.com')

# instantiating the OpenSearch client, and passing in the CLI profile
opensearch = boto3.client("opensearchserverless",'us-east-1')
host = os.getenv('opensearch_host')  # cluster endpoint, for example: my-test-domain.us-east-1.aoss.amazonaws.com
region = 'us-east-1'
service = 'aoss'
credentials = boto3.Session(profile_name=os.getenv('profile_name')).get_credentials()
auth = AWSV4SignerAuth(credentials, region, service)

client = OpenSearch(
    hosts=[{'host': host, 'port': 443}],
    http_auth=auth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    pool_maxsize=20
)

def get_embedding(body):
    """
    This function is used to generate the embeddings for each question the user submits.
    :param body: This is the question that is passed in to generate an embedding
    :return: A vector containing the embeddings of the passed in content
    """
    # defining the embeddings model
    modelId = 'amazon.titan-embed-text-v1'
    accept = 'application/json'
    contentType = 'application/json'
    # invoking the embedding model
    response = bedrock.invoke_model(body=body, modelId=modelId, accept=accept, contentType=contentType)
    # reading in the specific embedding
    response_body = json.loads(response.get('body').read())
    embedding = response_body.get('embedding')
    return embedding

def conversation_orchestrator(bedrock, model_id, system_prompts, messages):
    """
    Orchestrates the conversation between the user and the model.
    Args:
        bedrock: The Amazon Bedrock Runtime Client Object.
        model_id: The specific model to use for the conversation.
        system_prompts: The system prompts to use for the conversation.
        messages: A list of messages to send to the model that helps preserve context along with the latest message.

    Returns: The response from the model that answers the user's question and retains the context of previous question/answer
    pairs.

    """
    # Set the temperature for the model inference, controlling the randomness of the responses.
    temperature = 0.5
    # Set the top_k parameter for the model inference, determining how many of the top predictions to consider.
    top_k = 200
    # Create the inference configuration dictionary with the temperature setting.
    inference_config = {"temperature": temperature}
    # Additional inference parameters to use, including the top_k setting.
    additional_model_fields = {"top_k": top_k}
    # Call the converse method of the Bedrock client object to get a response from the model.
    response = bedrock.converse(
        modelId=model_id,
        messages=messages,
        #system=system_prompts,
        inferenceConfig=inference_config,
        #additionalModelRequestFields=additional_model_fields
    )
    # Return the response from the model.
    return response



def answer_query(user_input):
       
    messages = []

    userQuery = user_input
    # formatting the user input
    userQueryBody = json.dumps({"inputText": userQuery})
    # creating an embedding of the user input to perform a KNN search with
    userVectors = get_embedding(userQueryBody)
    # the query parameters for the KNN search performed by Amazon OpenSearch with the generated User Vector passed in.
    # TODO: If you wanted to add pre-filtering on the query you could by editing this query!
    query = {
        "size": 3,
        "query": {
            "knn": {
                "vector_field": {
                    "vector": userVectors, "k": 3
                }
            }
        },
        "_source": True,
        "fields": ["text"],
    }
    # performing the search on OpenSearch passing in the query parameters constructed above
    response = client.search(
        body=query,
        index=os.getenv("vector_index_name")
    )

    # Format Json responses into text
    similaritysearchResponse = ""
    # iterating through all the findings of Amazon openSearch and adding them to a single string to pass in as context
    for i in response["hits"]["hits"]:
        outputtext = i["fields"]["text"]
        similaritysearchResponse = similaritysearchResponse + "Info = " + str(outputtext)

        similaritysearchResponse = similaritysearchResponse
    
    # Configuring the Prompt for the LLM
    # TODO: EDIT THIS PROMPT TO OPTIMIZE FOR YOUR USE CASE
    

    prompt_data = f"""

    The following is text from a Topic  "{userQuery}" :

    {similaritysearchResponse}

    Generate multiple choice questions that tests my knowledge of the AWS Machine Learning Associate Exam. 
    I would like to be tested on above Topic. 
    You will then respond with 20 example questions, each with 4 answer choices. 
    In the explanation, include why each of the answer choices provided is right or wrong. 
    Do not provide the correct answer until after my selection.
    Provide information only based on the context provided.
    If you are unable to answer accurately, please say so.
    Please mention the sources of where the answers came from by referring to page numbers, specific books and chapters!

    Use line breaks and following format:
    \n
    Question #) \n
    A) \n
    B) \n
    C) \n
    D) \n

    Correct Answer:

    Explanation:
    
    """

    print(prompt_data)
    
    model_id = "amazon.titan-text-premier-v1:0"

    # Define the system prompts to guide the model's behavior, and set the general direction of the models role.
    system_prompts = [{"text": "You are a helpful assistant."}]
    
    # Format the user's message as a dictionary with role and content
    message = {
        "role": "user",
        "content": [{"text": prompt_data}]
    }
    
    # Append the formatted user message to the list of messages.
    messages.append(message)

   # Invoke the conversation orchestrator to get the model's response.
    response = conversation_orchestrator(bedrock,model_id, system_prompts, messages)
    
    # Extract the output message from the response.
    output_message = response['output']['message']
    
    print(f"usage: {response['usage']}")
    print(f"latencyMs: {response['metrics']}")

    messages.append(output_message)
    
    return output_message['content'][0]['text']