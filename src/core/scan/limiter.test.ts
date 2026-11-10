import { describe, expect, it } from 'vitest'
import { createLimiter } from './limiter'

/** A task the test finishes by hand, so it controls exactly what is running. */
function manualTask<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  let started = false
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    fn: () => {
      started = true
      return promise
    },
    get started() {
      return started
    },
    resolve,
    reject
  }
}

/** Lets queued promise callbacks run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createLimiter', () => {
  it('returns what the task returns', async () => {
    const limiter = createLimiter({ globalMax: 2, perBucketMax: 1 })
    expect(await limiter.run('ec2', async () => 42)).toBe(42)
  })

  it('passes a task failure on to the caller', async () => {
    const limiter = createLimiter({ globalMax: 2, perBucketMax: 1 })
    await expect(limiter.run('ec2', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })

  it('never runs more tasks at once than the global cap', async () => {
    const limiter = createLimiter({ globalMax: 2, perBucketMax: 5 })
    const tasks = [manualTask(), manualTask(), manualTask()]
    const runs = tasks.map((task, i) => limiter.run(`bucket-${i}`, task.fn))
    await tick()
    expect(tasks.map((task) => task.started)).toEqual([true, true, false])

    tasks[0]!.resolve()
    await tick()
    expect(tasks[2]!.started).toBe(true)

    tasks[1]!.resolve()
    tasks[2]!.resolve()
    await Promise.all(runs)
  })

  it('never runs more tasks of one bucket at once than the bucket cap', async () => {
    const limiter = createLimiter({ globalMax: 10, perBucketMax: 2 })
    const tasks = [manualTask(), manualTask(), manualTask()]
    const runs = tasks.map((task) => limiter.run('ec2', task.fn))
    await tick()
    expect(tasks.map((task) => task.started)).toEqual([true, true, false])

    tasks[1]!.resolve()
    await tick()
    expect(tasks[2]!.started).toBe(true)

    tasks[0]!.resolve()
    tasks[2]!.resolve()
    await Promise.all(runs)
  })

  it('lets another bucket through while one bucket is full', async () => {
    const limiter = createLimiter({ globalMax: 10, perBucketMax: 1 })
    const ec2First = manualTask()
    const ec2Second = manualTask()
    const rds = manualTask()
    const runs = [limiter.run('ec2', ec2First.fn), limiter.run('ec2', ec2Second.fn), limiter.run('rds', rds.fn)]
    await tick()
    expect([ec2First.started, ec2Second.started, rds.started]).toEqual([true, false, true])

    ec2First.resolve()
    ec2Second.resolve()
    rds.resolve()
    await Promise.all(runs)
  })

  it('starts waiting tasks of a bucket in the order they were queued', async () => {
    const limiter = createLimiter({ globalMax: 1, perBucketMax: 1 })
    const order: number[] = []
    const first = manualTask()
    const runs = [
      limiter.run('ec2', first.fn),
      limiter.run('ec2', async () => void order.push(1)),
      limiter.run('ec2', async () => void order.push(2)),
      limiter.run('ec2', async () => void order.push(3))
    ]
    first.resolve()
    await Promise.all(runs)
    expect(order).toEqual([1, 2, 3])
  })

  it('frees the slot when a task fails', async () => {
    const limiter = createLimiter({ globalMax: 1, perBucketMax: 1 })
    const failing = manualTask()
    const failed = limiter.run('ec2', failing.fn)
    const next = limiter.run('ec2', async () => 'ran')
    failing.reject(new Error('boom'))
    await expect(failed).rejects.toThrow('boom')
    expect(await next).toBe('ran')
  })

  it('frees the slot when a task throws before returning a promise', async () => {
    const limiter = createLimiter({ globalMax: 1, perBucketMax: 1 })
    const thrown = limiter.run('ec2', () => {
      throw new Error('sync boom')
    })
    await expect(thrown).rejects.toThrow('sync boom')
    expect(await limiter.run('ec2', async () => 'ran')).toBe('ran')
  })

  it('does not start a waiting task whose signal was aborted, and rejects it', async () => {
    const limiter = createLimiter({ globalMax: 1, perBucketMax: 1 })
    const running = manualTask()
    const waiting = manualTask()
    const controller = new AbortController()
    const first = limiter.run('ec2', running.fn)
    const second = limiter.run('ec2', waiting.fn, controller.signal)
    const settled = second.catch((error: unknown) => error)

    controller.abort()
    expect(await settled).toMatchObject({ name: 'AbortError' })

    running.resolve()
    await first
    await tick()
    expect(waiting.started).toBe(false)
  })

  it('an aborted waiting task does not use up a slot', async () => {
    const limiter = createLimiter({ globalMax: 1, perBucketMax: 1 })
    const running = manualTask()
    const controller = new AbortController()
    const first = limiter.run('ec2', running.fn)
    const aborted = limiter.run('ec2', async () => 'never', controller.signal).catch(() => 'aborted')
    const third = limiter.run('ec2', async () => 'ran')
    controller.abort()
    running.resolve()
    await first
    expect(await aborted).toBe('aborted')
    expect(await third).toBe('ran')
  })

  it('rejects straight away when the signal is already aborted', async () => {
    const limiter = createLimiter({ globalMax: 1, perBucketMax: 1 })
    const task = manualTask()
    await expect(limiter.run('ec2', task.fn, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(task.started).toBe(false)
  })

  it('refuses caps below one', () => {
    expect(() => createLimiter({ globalMax: 0, perBucketMax: 1 })).toThrow()
    expect(() => createLimiter({ globalMax: 1, perBucketMax: 0 })).toThrow()
  })
})
