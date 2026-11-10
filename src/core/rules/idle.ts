// CPU readings from CloudWatch, for the idle-cpu rule.
//
// One GetMetricData call per region, for running EC2 instances and available
// RDS instances only: the maximum CPUUtilization of each whole hour in the
// window (default 6 hours), up to 500 metrics per call.
//
// This module only measures. Whether a reading means "idle" is decided by the
// rule (rules.ts): every hour of the window must have a datapoint and the
// highest must be under the threshold. Missing or partial data never flags.
//
// Cost: GetMetricData is not in CloudWatch's free API allowance; it is
// charged per metric requested (about $0.01 per 1,000). So:
//   - the window ends at the start of the current hour, and a reading is
//     cached per resource until the next hour begins: one metric per
//     resource per hour, about 720 a month, under one cent
//   - stopped, stale and too-young resources are never asked about
//   - the rule can be switched off, and then nothing is asked at all
//
// A failed region becomes a ScanError with scanner 'cloudwatch'. Its
// resources get no reading, which leaves the idle rule undecided for them.

import { CloudWatchClient, paginateGetMetricData, type MetricDataQuery } from '@aws-sdk/client-cloudwatch'
import type { Resource, ScanError } from '../../shared/types'
import type { ClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { Repo } from '../store/repo'

/** The busiest the CPU got in the window, from one datapoint per hour. */
export interface CpuReading {
  /** Highest hourly maximum of CPUUtilization, in percent. null = no datapoints at all. */
  maxCpu: number | null
  /** How many of the window's hours have a datapoint. Fewer than the window = partial data. */
  datapoints: number
  /** ISO time the window ends at (the start of the current hour). */
  windowEnd: string
}

export interface CpuReport {
  /** By resource key. A resource that was skipped, or whose region failed, has no entry. */
  readings: Map<string, CpuReading>
  errors: ScanError[]
}

export interface IdleDetector {
  read(resources: readonly (Resource & { stale: boolean })[], windowHours: number, signal: AbortSignal): Promise<CpuReport>
}

export interface IdleDetectorOptions {
  clients: ClientFactory
  cache: Pick<Repo, 'getCpuReading' | 'putCpuReading'>
  now?: () => Date
}

const HOUR_MS = 3_600_000
const PERIOD_SECONDS = 3600
/** The most metrics one GetMetricData call accepts. */
const MAX_METRICS_PER_CALL = 500

/** Where each measurable kind keeps its CPU metric, and the state in which it has one. */
const CPU_METRIC: Partial<Record<Resource['kind'], { namespace: string; dimension: string; state: string }>> = {
  'ec2-instance': { namespace: 'AWS/EC2', dimension: 'InstanceId', state: 'running' },
  'rds-instance': { namespace: 'AWS/RDS', dimension: 'DBInstanceIdentifier', state: 'available' }
}

export function createIdleDetector(options: IdleDetectorOptions): IdleDetector {
  const { clients, cache } = options
  const now = options.now ?? (() => new Date())

  async function measure(
    region: string,
    resources: readonly Resource[],
    start: Date,
    end: Date,
    signal: AbortSignal
  ): Promise<Map<string, CpuReading>> {
    const client = clients.get(CloudWatchClient, region)
    const queries: MetricDataQuery[] = resources.map((resource, index) => {
      const metric = CPU_METRIC[resource.kind]!
      return {
        Id: `m${index}`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: metric.namespace,
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: metric.dimension, Value: resource.id }]
          },
          Period: PERIOD_SECONDS,
          Stat: 'Maximum'
        }
      }
    })

    // The values of one metric can be spread over several pages.
    const values = new Map<string, number[]>()
    const input = { StartTime: start, EndTime: end, MetricDataQueries: queries }
    for await (const page of paginateGetMetricData({ client }, input, { abortSignal: signal })) {
      for (const result of page.MetricDataResults ?? []) {
        if (!result.Id) continue
        values.set(result.Id, [...(values.get(result.Id) ?? []), ...(result.Values ?? [])])
      }
    }

    const readings = new Map<string, CpuReading>()
    resources.forEach((resource, index) => {
      const points = values.get(`m${index}`) ?? []
      readings.set(resource.key, {
        maxCpu: points.length > 0 ? Math.max(...points) : null,
        datapoints: points.length,
        windowEnd: end.toISOString()
      })
    })
    return readings
  }

  return {
    async read(resources, windowHours, signal) {
      // Whole hours only, so every datapoint covers a complete hour.
      const end = new Date(Math.floor(now().getTime() / HOUR_MS) * HOUR_MS)
      const start = new Date(end.getTime() - windowHours * HOUR_MS)
      const windowEnd = end.toISOString()

      const readings = new Map<string, CpuReading>()
      const errors: ScanError[] = []
      const toMeasure = new Map<string, Resource[]>()

      for (const resource of resources) {
        const metric = CPU_METRIC[resource.kind]
        if (!metric || resource.stale || resource.state !== metric.state) continue
        // Started (or created) inside the window: part of the window is not its own.
        if (!resource.createdAt || Date.parse(resource.createdAt) > start.getTime()) continue

        const cached = cache.getCpuReading(resource.key)
        if (cached && cached.windowEnd === windowEnd) {
          readings.set(resource.key, cached)
          continue
        }
        const inRegion = toMeasure.get(resource.region) ?? []
        inRegion.push(resource)
        toMeasure.set(resource.region, inRegion)
      }

      for (const [region, inRegion] of toMeasure) {
        try {
          for (let from = 0; from < inRegion.length; from += MAX_METRICS_PER_CALL) {
            const batch = inRegion.slice(from, from + MAX_METRICS_PER_CALL)
            for (const [key, reading] of await measure(region, batch, start, end, signal)) {
              cache.putCpuReading(key, reading)
              readings.set(key, reading)
            }
          }
        } catch (error) {
          if (signal.aborted) throw error
          errors.push({ scanner: 'cloudwatch', region, ...classifyAwsError(error) })
        }
      }

      return { readings, errors }
    }
  }
}
