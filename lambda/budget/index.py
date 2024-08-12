import boto3
import os
import time

def handler(event, context):
    cloudformation = boto3.client('cloudformation')
    budgets = boto3.client('budgets')
    sts = boto3.client('sts')
    
    # Retrieve environment variables
    budget_name = os.environ.get('BUDGET_NAME')
    threshold_amount = float(os.environ.get('THRESHOLD_AMOUNT', '0'))
    stack_name = os.environ.get('STACK_NAME')

    # Validate required parameters
    if not stack_name:
        return {
            'statusCode': 400,
            'body': 'STACK_NAME environment variable not set.'
        }
    if not budget_name:
        return {
            'statusCode': 400,
            'body': 'BUDGET_NAME environment variable not set.'
        }

    # Get the AWS account ID dynamically
    try:
        response = sts.get_caller_identity()
        account_id = response['Account']
    except Exception as e:
        return {
            'statusCode': 500,
            'body': f'Error retrieving account ID: {str(e)}'
        }

    # Fetch the current budget amount
    try:
        response = budgets.describe_budget(AccountId=account_id, BudgetName=budget_name)
        budget_amount = response['Budget']['BudgetLimit']['Amount']
    except Exception as e:
        return {
            'statusCode': 500,
            'body': f'Error fetching budget: {str(e)}'
        }

    # Check if the threshold amount has been exceeded
    if float(budget_amount) >= threshold_amount:
        delay = 2  # Polling delay in seconds
        
        try:
            # Attempt to delete the stack
            cloudformation.delete_stack(StackName=stack_name)
            print(f"Delete stack request sent. StackName: {stack_name}")

            # Poll for stack status until it is DELETE_COMPLETE or DELETE_IN_PROGRESS
            while True:
                stack_description = cloudformation.describe_stacks(StackName=stack_name)
                stack_status = stack_description['Stacks'][0]['StackStatus']
                
                if stack_status == 'DELETE_COMPLETE':
                    return {
                        'statusCode': 200,
                        'body': f'Stack {stack_name} deletion completed successfully.'
                    }
                
                elif stack_status == 'DELETE_IN_PROGRESS':
                    print(f"Stack deletion in progress. Current status: {stack_status}. Retrying in {delay} seconds...")
                
                else:
                    # If stack is not in a deletion-related status, retry the deletion
                    print(f"Unexpected stack status: {stack_status}. Retrying deletion...")
                    cloudformation.delete_stack(StackName=stack_name)

                # Wait before the next status check
                time.sleep(delay)

        except cloudformation.exceptions.ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code in ['ValidationError', 'NotFoundException']:
                # Stack not found or in a terminal state, log and exit
                print(f"Stack not found or already in a terminal state: {str(e)}")
                return {
                    'statusCode': 200,
                    'body': 'Stack was not found or already in a terminal state. No further action needed.'
                }
            else:
                # If maximum retries exceeded, return error response
                return {
                    'statusCode': 500,
                    'body': f'Error deleting stack: {str(e)}'
                }
    else:
        return {
            'statusCode': 200,
            'body': 'Budget threshold not exceeded. No action taken.'
        }
