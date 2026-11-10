// Limits how many tasks run at once: a cap on the total, and a cap per
// bucket. The scan engine uses the AWS service as the bucket, so one service
// is never called in every region at the same moment.
//
// A task that cannot start waits in a queue. When a slot frees up, the oldest
// waiting task whose bucket has room starts.

export interface LimiterOptions {
  /** Most tasks running at once, across all buckets. */
  globalMax: number
  /** Most tasks of one bucket running at once. */
  perBucketMax: number
}

export interface Limiter {
  /**
   * Runs `task` when there is room and returns its result. If `signal` aborts
   * while the task is still waiting, it never starts and the promise rejects
   * with an AbortError. A task that has started is not interrupted by the
   * limiter; the task itself must watch the signal.
   */
  run<T>(bucket: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

interface Waiting {
  bucket: string
  start: () => void
}

function abortError(): Error {
  return new DOMException('The task was cancelled before it started.', 'AbortError')
}

export function createLimiter(options: LimiterOptions): Limiter {
  const { globalMax, perBucketMax } = options
  if (!Number.isInteger(globalMax) || globalMax < 1 || !Number.isInteger(perBucketMax) || perBucketMax < 1) {
    throw new Error('Limiter caps must be whole numbers of at least 1.')
  }

  let running = 0
  const runningByBucket = new Map<string, number>()
  const queue: Waiting[] = []

  const hasRoom = (bucket: string) => running < globalMax && (runningByBucket.get(bucket) ?? 0) < perBucketMax

  const startWaiting = () => {
    // Oldest first, skipping tasks whose bucket is full.
    for (let i = 0; i < queue.length && running < globalMax; ) {
      const waiting = queue[i]!
      if (hasRoom(waiting.bucket)) {
        queue.splice(i, 1)
        waiting.start()
      } else {
        i++
      }
    }
  }

  return {
    run<T>(bucket: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError())
          return
        }

        const release = () => {
          running--
          runningByBucket.set(bucket, (runningByBucket.get(bucket) ?? 1) - 1)
          startWaiting()
        }

        const start = () => {
          signal?.removeEventListener('abort', onAbort)
          running++
          runningByBucket.set(bucket, (runningByBucket.get(bucket) ?? 0) + 1)
          // Promise.resolve().then(task) also catches a task that throws synchronously.
          Promise.resolve()
            .then(task)
            .then(
              (value) => {
                release()
                resolve(value)
              },
              (error: unknown) => {
                release()
                reject(error)
              }
            )
        }

        const waiting: Waiting = { bucket, start }

        function onAbort() {
          const index = queue.indexOf(waiting)
          if (index === -1) return
          queue.splice(index, 1)
          reject(abortError())
        }

        if (hasRoom(bucket) && queue.every((other) => other.bucket !== bucket)) {
          start()
        } else {
          queue.push(waiting)
          signal?.addEventListener('abort', onAbort, { once: true })
        }
      })
    }
  }
}
