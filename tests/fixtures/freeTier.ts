// Free Tier API data in the shape the SDK returns it.
//
// `freePlanActive` and the three "Always Free" usage rows follow a recording
// made with `scripts/record-fixtures.ts --freetier-only` on a free-plan
// account (2026-11-10): same fields, same strings, with the credit amount,
// the end date and the descriptions replaced by made-up values.
//
// The paid-plan state and the "12 Months Free" rows could NOT be recorded
// (the test account is on the free plan). They are written from the API
// reference and the usage types of the Price List recording, and are marked
// below. Replace them with recorded data when a paid account is available.

import type { FreeTierUsage, GetAccountPlanStateResponse } from '@aws-sdk/client-freetier'

/** Recorded shape: a free-plan account with credits left. */
export const freePlanActive: GetAccountPlanStateResponse = {
  accountId: '111122223333',
  accountPlanType: 'FREE',
  accountPlanStatus: 'ACTIVE',
  accountPlanRemainingCredits: { amount: 150.5, unit: 'USD' },
  accountPlanExpirationDate: new Date('2027-02-18T12:00:00.000Z')
}

/** Not recorded. A paid account that still has credits. */
export const paidPlanWithCredits: GetAccountPlanStateResponse = {
  accountId: '111122223333',
  accountPlanType: 'PAID',
  accountPlanStatus: 'ACTIVE',
  accountPlanRemainingCredits: { amount: 42, unit: 'USD' }
}

/** Not recorded. A paid account without credits: the fields AWS marks optional are left out. */
export const paidPlanNoCredits: GetAccountPlanStateResponse = {
  accountId: '111122223333',
  accountPlanType: 'PAID',
  accountPlanStatus: 'ACTIVE'
}

/** Recorded shape: what a free-plan account returns. Region is "global", type is "Always Free". */
export const alwaysFreeRows: FreeTierUsage[] = [
  {
    service: 'AWS Glue',
    operation: 'Request',
    usageType: 'Catalog-Request',
    region: 'global',
    actualUsageAmount: 56,
    forecastedUsageAmount: 168,
    limit: 1000000,
    unit: 'Request',
    description: '1000000.0 Request are always free per month as part of AWS Free Usage Tier (Global-Catalog-Request)',
    freeTierType: 'Always Free'
  },
  {
    service: 'AmazonCloudWatch',
    operation: '',
    usageType: 'TimedStorage-ByteHrs',
    region: 'global',
    actualUsageAmount: 2e-7,
    forecastedUsageAmount: 6e-7,
    limit: 5,
    unit: 'GB-Mo',
    description: '5.0 GB-Mo are always free per month as part of AWS Free Usage Tier (Global-TimedStorage-ByteHrs)',
    freeTierType: 'Always Free'
  },
  {
    service: 'AWS Key Management Service',
    operation: '',
    usageType: 'KMS-Requests',
    region: 'global',
    actualUsageAmount: 4,
    forecastedUsageAmount: 12,
    limit: 20000,
    unit: 'Requests',
    description: '20000.0 Requests are always free per month as part of AWS Free Usage Tier (Global-KMS-Requests)',
    freeTierType: 'Always Free'
  }
]

/** Not recorded. One "12 Months Free" row, as an account opened before 15 July 2025 would have. */
export function twelveMonthRow(usageType: string, actual: number, forecast: number, limit: number, unit = 'Hrs'): FreeTierUsage {
  return {
    service: 'Amazon Elastic Compute Cloud',
    operation: '',
    usageType,
    region: 'global',
    actualUsageAmount: actual,
    forecastedUsageAmount: forecast,
    limit,
    unit,
    description: `${limit} ${unit} for free for 12 months as part of AWS Free Usage Tier (${usageType})`,
    freeTierType: '12 Months Free'
  }
}
