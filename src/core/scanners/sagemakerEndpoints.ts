// SageMaker real-time inference endpoints in one region. The only scanner that
// needs more than one call per resource:
//
//   ListEndpoints            names and status            (paginated)
//   DescribeEndpoint         current instance count per variant, config name
//   DescribeEndpointConfig   instance type per variant   (cached per scan: endpoints share configs)
//
// An endpoint bills for every instance in every variant, shadow variants
// included, while it exists. Serverless variants bill per request instead and
// have no hourly rate.
//
// Attrs hold scalars only, so the variant list is stored as a JSON string
// (`SageMakerVariant[]`), next to two totals that rules can read directly.
//
// One deliberate exception to "scanners never catch": a "Could not find" error
// means the thing is gone, not that the scan failed. An endpoint can be deleted
// between the list and the describe call (it is then skipped), and a config can
// be deleted while its endpoint keeps running, which AWS allows (the endpoint is
// kept, with its instance type unknown). Every other error escapes as usual.

import {
  DescribeEndpointCommand,
  DescribeEndpointConfigCommand,
  paginateListEndpoints,
  SageMakerClient,
  type DescribeEndpointConfigOutput,
  type DescribeEndpointOutput,
  type EndpointSummary,
  type ProductionVariant,
  type ProductionVariantSummary
} from '@aws-sdk/client-sagemaker'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'

/** One entry of the JSON `variants` attribute. */
export interface SageMakerVariant {
  name: string
  /** From the endpoint config. Null for serverless variants, or when the config is gone. */
  instanceType: string | null
  /** Instances running now (after autoscaling). 0 for serverless variants. */
  instanceCount: number
  serverless: boolean
  /** Shadow variants receive a copy of traffic, and bill like any other. */
  shadow: boolean
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'ValidationException' && /could not find/i.test(error.message)
  )
}

/** "InService" -> "in-service", to match the lower-case states of the other kinds. */
function normaliseStatus(status: string): string {
  return status.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

function toVariants(
  live: ProductionVariantSummary[] | undefined,
  configured: ProductionVariant[] | undefined,
  shadow: boolean
): SageMakerVariant[] {
  const config = new Map((configured ?? []).map((variant) => [variant.VariantName, variant]))
  return (live ?? []).map((variant) => {
    const planned = config.get(variant.VariantName)
    const serverless = !!(variant.CurrentServerlessConfig ?? variant.DesiredServerlessConfig ?? planned?.ServerlessConfig)
    return {
      name: variant.VariantName ?? '',
      instanceType: serverless ? null : (planned?.InstanceType ?? null),
      instanceCount: serverless
        ? 0
        : (variant.CurrentInstanceCount ?? variant.DesiredInstanceCount ?? planned?.InitialInstanceCount ?? 0),
      serverless,
      shadow
    }
  })
}

function toResource(
  summary: EndpointSummary,
  endpoint: DescribeEndpointOutput,
  config: DescribeEndpointConfigOutput | null,
  ctx: ScanContext
): Resource {
  const id = endpoint.EndpointName ?? summary.EndpointName ?? ''
  const variants = [
    ...toVariants(endpoint.ProductionVariants, config?.ProductionVariants, false),
    ...toVariants(endpoint.ShadowProductionVariants, config?.ShadowProductionVariants, true)
  ]
  const status = endpoint.EndpointStatus ?? summary.EndpointStatus
  const created = endpoint.CreationTime ?? summary.CreationTime

  return {
    key: resourceKey(ctx.accountId, 'sagemaker-endpoint', ctx.region, id),
    kind: 'sagemaker-endpoint',
    region: ctx.region,
    id,
    // Endpoint names are chosen by the user and are the only name there is.
    name: id,
    state: status ? normaliseStatus(status) : 'unknown',
    ...(created ? { createdAt: created.toISOString() } : {}),
    attrs: {
      variants: JSON.stringify(variants),
      instanceCount: variants.reduce((total, variant) => total + variant.instanceCount, 0),
      serverless: variants.some((variant) => variant.serverless)
    }
  }
}

export const sagemakerEndpoints: Scanner = {
  kind: 'sagemaker-endpoint',
  service: 'sagemaker',
  requiredActions: ['sagemaker:ListEndpoints', 'sagemaker:DescribeEndpoint', 'sagemaker:DescribeEndpointConfig'],

  async scan(ctx) {
    const client = ctx.clients.get(SageMakerClient, ctx.region)
    const options = { abortSignal: ctx.signal }

    const summaries: EndpointSummary[] = []
    for await (const page of paginateListEndpoints({ client }, {}, options)) {
      for (const summary of page.Endpoints ?? []) {
        if (summary.EndpointName) summaries.push(summary)
      }
    }

    // Described one after another: a student account has a handful of endpoints
    // at most, and the engine already runs regions in parallel.
    const configs = new Map<string, Promise<DescribeEndpointConfigOutput | null>>()
    const describeConfig = (name: string) => {
      let config = configs.get(name)
      if (!config) {
        config = client
          .send(new DescribeEndpointConfigCommand({ EndpointConfigName: name }), options)
          .catch((error: unknown) => {
            if (isNotFound(error)) return null
            throw error
          })
        configs.set(name, config)
      }
      return config
    }

    const resources: Resource[] = []
    for (const summary of summaries) {
      let endpoint: DescribeEndpointOutput
      try {
        endpoint = await client.send(new DescribeEndpointCommand({ EndpointName: summary.EndpointName }), options)
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      const config = endpoint.EndpointConfigName ? await describeConfig(endpoint.EndpointConfigName) : null
      resources.push(toResource(summary, endpoint, config, ctx))
    }
    return resources
  }
}
