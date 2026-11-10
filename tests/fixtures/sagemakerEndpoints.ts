// Hand-written SageMaker data (ListEndpoints, DescribeEndpoint,
// DescribeEndpointConfig) in the shape the SDK returns it, with made-up names.
// Replace or extend with recorded responses from `scripts/record-fixtures.ts`
// (see tests/fixtures/recorded/).

import type {
  DescribeEndpointConfigOutput,
  DescribeEndpointOutput,
  EndpointSummary
} from '@aws-sdk/client-sagemaker'

const ARN = 'arn:aws:sagemaker:eu-west-1:111122223333'

function summary(name: string, status: EndpointSummary['EndpointStatus'], created: string): EndpointSummary {
  return {
    EndpointName: name,
    EndpointArn: `${ARN}:endpoint/${name}`,
    CreationTime: new Date(created),
    LastModifiedTime: new Date(created),
    EndpointStatus: status
  }
}

// --- A GPU endpoint that autoscaled from 1 to 2 instances -------------------

export const gpuSummary = summary('llm-demo', 'InService', '2026-11-09T18:00:00.000Z')

export const gpuEndpoint: DescribeEndpointOutput = {
  EndpointName: 'llm-demo',
  EndpointArn: `${ARN}:endpoint/llm-demo`,
  EndpointConfigName: 'llm-demo-config',
  EndpointStatus: 'InService',
  CreationTime: new Date('2026-11-09T18:00:00.000Z'),
  LastModifiedTime: new Date('2026-11-09T18:20:00.000Z'),
  ProductionVariants: [
    {
      VariantName: 'AllTraffic',
      CurrentWeight: 1,
      DesiredWeight: 1,
      CurrentInstanceCount: 2,
      DesiredInstanceCount: 2,
      DeployedImages: [{ SpecifiedImage: '763104351884.dkr.ecr.eu-west-1.amazonaws.com/huggingface:latest' }]
    }
  ]
}

export const gpuConfig: DescribeEndpointConfigOutput = {
  EndpointConfigName: 'llm-demo-config',
  EndpointConfigArn: `${ARN}:endpoint-config/llm-demo-config`,
  CreationTime: new Date('2026-11-09T17:55:00.000Z'),
  ProductionVariants: [
    { VariantName: 'AllTraffic', ModelName: 'llm-demo-model', InitialInstanceCount: 1, InstanceType: 'ml.g5.xlarge' }
  ]
}

// --- A serverless endpoint: billed per use, so no hourly rate ---------------

export const serverlessSummary = summary('classifier', 'InService', '2026-11-05T09:00:00.000Z')

export const serverlessEndpoint: DescribeEndpointOutput = {
  EndpointName: 'classifier',
  EndpointArn: `${ARN}:endpoint/classifier`,
  EndpointConfigName: 'classifier-config',
  EndpointStatus: 'InService',
  CreationTime: new Date('2026-11-05T09:00:00.000Z'),
  LastModifiedTime: new Date('2026-11-05T09:05:00.000Z'),
  ProductionVariants: [
    { VariantName: 'AllTraffic', CurrentServerlessConfig: { MemorySizeInMB: 2048, MaxConcurrency: 5 } }
  ]
}

export const serverlessConfig: DescribeEndpointConfigOutput = {
  EndpointConfigName: 'classifier-config',
  EndpointConfigArn: `${ARN}:endpoint-config/classifier-config`,
  CreationTime: new Date('2026-11-05T08:55:00.000Z'),
  ProductionVariants: [
    { VariantName: 'AllTraffic', ModelName: 'classifier-model', ServerlessConfig: { MemorySizeInMB: 2048, MaxConcurrency: 5 } }
  ]
}

// --- Two production variants plus a shadow variant, still updating ----------

export const abTestSummary = summary('ranker', 'Updating', '2026-11-01T12:00:00.000Z')

export const abTestEndpoint: DescribeEndpointOutput = {
  EndpointName: 'ranker',
  EndpointArn: `${ARN}:endpoint/ranker`,
  EndpointConfigName: 'ranker-config',
  EndpointStatus: 'Updating',
  CreationTime: new Date('2026-11-01T12:00:00.000Z'),
  LastModifiedTime: new Date('2026-11-10T13:00:00.000Z'),
  ProductionVariants: [
    { VariantName: 'champion', CurrentInstanceCount: 1 },
    // Still coming up: no current count yet.
    { VariantName: 'challenger', DesiredInstanceCount: 1 }
  ],
  ShadowProductionVariants: [{ VariantName: 'shadow', CurrentInstanceCount: 1 }]
}

export const abTestConfig: DescribeEndpointConfigOutput = {
  EndpointConfigName: 'ranker-config',
  EndpointConfigArn: `${ARN}:endpoint-config/ranker-config`,
  CreationTime: new Date('2026-11-10T12:55:00.000Z'),
  ProductionVariants: [
    { VariantName: 'champion', ModelName: 'ranker-v1', InitialInstanceCount: 1, InstanceType: 'ml.m5.large' },
    { VariantName: 'challenger', ModelName: 'ranker-v2', InitialInstanceCount: 1, InstanceType: 'ml.c5.xlarge' }
  ],
  ShadowProductionVariants: [
    { VariantName: 'shadow', ModelName: 'ranker-v3', InitialInstanceCount: 1, InstanceType: 'ml.m5.large' }
  ]
}
