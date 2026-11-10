// CPU readings from CloudWatch, for the idle-cpu rule.

/** The busiest the CPU got in the window, from one datapoint per hour. */
export interface CpuReading {
  /** Highest hourly maximum of CPUUtilization, in percent. null = no datapoints at all. */
  maxCpu: number | null
  /** How many of the window's hours have a datapoint. Fewer than the window = partial data. */
  datapoints: number
  /** ISO time the window ends at (the start of the current hour). */
  windowEnd: string
}
