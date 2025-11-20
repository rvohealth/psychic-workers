import { Job, Queue, WorkerOptions } from 'bullmq'
import parallelTestSafeQueueName from '../background/helpers/parallelTestSafeQueueName.js'
import background, { Background } from '../background/index.js'
import { BackgroundJobData } from '../types/background.js'

const LOCK_TOKEN = 'psychic-test-worker'

export default class WorkerTestUtils {
  /*
   * Safely encapsulate's a queue name in parallel test runs,
   * capturing the VITEST_POOL_ID and appending it to the
   * end of the queue name if VITEST_POOL_ID > 1
   */
  public static parallelTestSafeQueueName(queueName: string) {
    return parallelTestSafeQueueName(queueName)
  }

  /*
   * Works off all of the jobs in all queues. The jobs
   * are worked off in a round-robin fashion until every queue
   * is empty, at which point the promise will resolve
   *
   * ```ts
   * await MyService.background('someMethod', ...)
   * await WorkerTestUtils.work()
   * // now you can safely assert the results of your background job
   * ```
   *
   * NOTE: this is only useful if you are running with `testInvocation=manual`.
   * make sure to set this in your workers config, or else in your test,
   * so that jobs are successfully commited to the queue and can be worked off.
   */
  public static async work(opts: TestWorkerWorkOffOpts = {}) {
    background.connect()
    const queues = background.queues

    let workWasDone: boolean = true

    do {
      workWasDone = false
      for (const queue of queues) {
        if (opts.queue && !this.queueNamesMatch(queue, opts.queue)) continue
        workWasDone ||= await this.workOne(queue)
      }
    } while (workWasDone)
  }

  public static async workScheduled(opts: TestWorkerScheduledWorkOffOpts = {}) {
    background.connect()

    const queues = opts.queue
      ? background.queues.filter(queue => queue.name === opts.queue)
      : background.queues

    if (opts.queue && !queues.length)
      throw new Error(
        `Expected to find queue with name: ${opts.queue}, but none were found by that name. The queue names available are: ${background.queues.map(queue => queue.name).join(', ')}`,
      )

    for (const queue of queues) {
      const jobs = await queue.getDelayed()

      for (const job of jobs) {
        const data = job.data as BackgroundJobData
        if (opts.for) {
          if (data.globalName === opts.for.globalName) {
            await background.doWork(job)
          }
        } else {
          await background.doWork(job)
        }
      }
    }
  }

  /*
   * iterates through each registered queue, and cleans out all
   * jobs, including completed, failed, and scheduled jobs. This
   * is especially useful before a test where you plan to exercise
   * background jobs manually.
   *
   * If your entire app is continuously exercising background jobs
   * manually, you may want to do this in your spec/setup/hooks.ts file,
   * so that it can be called before every test.
   *
   * ```ts
   * beforeEach(async () => {
   *   await WorkerTestUtils.clean()
   * })
   * ```
   */
  public static async clean() {
    background.connect()

    for (const queue of background.queues) {
      // clears all non-scheduled, non-completed, and non-failed jobs
      await queue.drain()

      // clear out completed and failed jobs
      await queue.clean(0, 10000, 'completed')
      await queue.clean(0, 10000, 'failed')

      // clear out scheduled jobs
      const schedulers = await queue.getJobSchedulers()
      for (const scheduler of schedulers) {
        await queue.removeJobScheduler(scheduler.key)
      }
    }
  }

  private static async workOne(queue: Queue): Promise<boolean> {
    const worker = new Background.Worker(queue.name, async job => await background.doWork(job), {
      autorun: false,
      connection: queue.client,
      concurrency: 1,
    } as WorkerOptions)

    if (!worker) throw new Error(`Failed to find worker for queue: ${queue.name}`)

    const job = await worker.getNextJob(LOCK_TOKEN)
    if (!job) return false

    await this.processJob(job)
    return true
  }

  private static queueNamesMatch(queue: Queue, compareQueueName: string): boolean {
    return (
      queue.name === parallelTestSafeQueueName(compareQueueName) ||
      queue.name === `{${parallelTestSafeQueueName(compareQueueName)}`
    )
  }

  private static async processJob(job: Job) {
    try {
      const res = await background.doWork(job)
      await job.moveToCompleted(res, LOCK_TOKEN, false)
    } catch (err) {
      await job.moveToFailed(err as Error, LOCK_TOKEN, false)
    }
  }
}

interface TestWorkerWorkOffOpts {
  queue?: string
}

interface TestWorkerScheduledWorkOffOpts {
  queue?: string
  for?: { globalName: string }
}
