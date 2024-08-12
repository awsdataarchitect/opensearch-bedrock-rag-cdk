import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

export class BudgetTerminationAspect implements cdk.IAspect {
    private readonly budgetName: string;
    private readonly thresholdAmount: number;

    constructor(budgetName: string, thresholdAmount: number) {
        this.budgetName = budgetName;
        this.thresholdAmount = thresholdAmount;
    }

    public visit(node: Construct): void {
        if (node instanceof cdk.Stack) {
            this.addBudgetTermination(node);
        }
    }

    private addBudgetTermination(stack: cdk.Stack) {
        // Lambda Function
        const terminationFunction = new lambda.Function(stack, 'BudgetTerminationFunction', {
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.handler',
            functionName: `BudgetTerminationFunction-${cdk.Aws.STACK_NAME}`,
            timeout: cdk.Duration.seconds(899),
            code: lambda.Code.fromAsset('lambda/budget'),
            environment: {
                STACK_NAME: stack.stackName,
                BUDGET_NAME: this.budgetName,
                THRESHOLD_AMOUNT: this.thresholdAmount.toString(),
            },
            logGroup: new cdk.aws_logs.LogGroup(stack, 'BudgetTerminationFunctionLogGroup', {
                logGroupName: `/aws/lambda/BudgetTerminationFunction-${cdk.Aws.STACK_NAME}`,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // Grant Lambda permissions to delete stack
        terminationFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['cloudformation:*'],
            resources: [`arn:aws:cloudformation:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stack/${stack.stackName}/*`],
        }));
        terminationFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['budgets:*'],
            resources: [`arn:aws:budgets::${cdk.Aws.ACCOUNT_ID}:budget/*`],
        }));

        const app = stack.node.root as cdk.App;
        let budgetExists = false;
        let ragBudget: budgets.CfnBudget | undefined

        // Iterate through all stacks in the app
        for (const stack of app.node.children) {
            if (stack instanceof cdk.Stack) {
                const existingBudget = stack.node.tryFindChild('Budget') as budgets.CfnBudget | undefined;
                if (existingBudget) {
                    ragBudget = existingBudget
                    budgetExists = true;
                    let snsTopicExists = stack.node.tryFindChild('BudgetAlertTopic') as sns.Topic | undefined;
                    if (snsTopicExists) {
                        // Subscribe Lambda Function to SNS Topic
                        snsTopicExists.addSubscription(new subscriptions.LambdaSubscription(terminationFunction))
                    }
                    break;
                }
            }
        }

        if (budgetExists) {
            return;
        }

        // Create AWS Budget with improved error handling
        try {
            //budget construct
            const ragBudget = new budgets.CfnBudget(stack, 'Budget', {
                budget: {
                    budgetName: this.budgetName,
                    budgetType: 'COST',
                    timeUnit: 'DAILY',
                    costTypes: {
                        includeCredit: false,
                        includeRefund: false,
                    },
                    budgetLimit: {
                        amount: this.thresholdAmount,
                        unit: 'USD',
                    },

                }
            });

            let snsTopicExists = stack.node.tryFindChild('BudgetAlertTopic') as sns.Topic | undefined;
            if (!snsTopicExists) {
                const snsTopic = new sns.Topic(stack, 'BudgetAlertTopic', {
                    displayName: `BudgetAlertTopic-${cdk.Aws.STACK_NAME}`,
                });
                snsTopic.addSubscription(new subscriptions.LambdaSubscription(terminationFunction));
                snsTopic.addToResourcePolicy(new iam.PolicyStatement({
                    actions: ['SNS:Publish'],
                    principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
                    resources: [snsTopic.topicArn],
                }));

                ragBudget.addPropertyOverride('NotificationsWithSubscribers', [
                    {
                        Notification: {
                            NotificationType: 'ACTUAL',
                            Threshold: 100,
                            ComparisonOperator: 'GREATER_THAN',
                        },
                        Subscribers: [
                            {
                                SubscriptionType: 'SNS',
                                Address: cdk.Lazy.string({ produce: () => snsTopic.topicArn }),
                            },
                        ],
                    },
                ])
            }
        } catch (error) {
            console.error('Error creating budget:', error);
        }

    }
}