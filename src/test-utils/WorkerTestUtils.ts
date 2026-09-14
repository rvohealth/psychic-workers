import { Job, Queue, WorkerOptions } from 'bullmq'
import parallelTestSafeQueueName from '../background/helpers/parallelTestSafeQueueName.js'
import background, { Background } from '../background/index.js'
import RateLimitedPsychicJob from '../error/background/RateLimitedPsychicJob.js'
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
   *
   * A job that throws `RateLimitedPsychicJob` stops the loop: on a queue whose
   * workers carry a BullMQ `limiter` the job is moved back to the queue (no
   * attempt counted) and the call rejects with that error; on a queue whose
   * workers carry none, the job fails with the misconfiguration error that
   * production would fail it with, and the call rejects with that instead.
   */
  public static async work(opts: TestWorkerWorkOffOpts = {}) {
    background.connect()
    const queues = background.queues

    let workWasDone: boolean

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
            await this.doScheduledWork(job, queue)
          }
        } else {
          await this.doScheduledWork(job, queue)
        }
      }
    }
  }

  /**
   * runs a delayed job in place. A `RateLimitedPsychicJob` thrown from a job on
   * a queue whose workers carry no BullMQ `limiter` surfaces as the same
   * misconfiguration error production would fail the job with; on a queue whose
   * workers carry one, it propagates untranslated so the spec can assert on it.
   */
  private static async doScheduledWork(job: Job, queue: Queue) {
    try {
      await background.doWork(job)
    } catch (err) {
      throw background.misconfiguredRateLimitSignal(err, queue) ?? err
    }
  }

  /*
   * iterates through each registered queue, and cleans out all
   * jobs, including waiting, paused, prioritized, delayed, completed,
   * failed, and scheduled jobs. This is especially useful before a test
   * where you plan to exercise background jobs manually.
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
      // clears waiting, paused, and prioritized jobs, as well as delayed jobs
      // (i.e. jobs which have failed and are awaiting a retry). Delayed jobs which
      // belong to a job scheduler are intentionally left alone by BullMQ here, and
      // are cleaned up below when their scheduler is removed.
      await queue.drain(true)

      // clear out completed and failed jobs
      await queue.clean(0, 10000, 'completed')
      await queue.clean(0, 10000, 'failed')

      // clear out abandoned active jobs. `drain` does not touch `active`, so a
      // job that was fetched with `getNextJob` and never moved on outlives every
      // other step here — and outlives the process, leaving a job in `active`
      // that the next run of the suite counts. `job.remove()` refuses a job
      // whose lock is still held, so one another process is genuinely working is
      // left alone; only one whose lock has lapsed (or was released) is removed.
      // A job abandoned seconds ago still holds its lock (BullMQ's default
      // `lockDuration` is 30s) and is skipped until it lapses, which is why the
      // spec that fetches a job by hand also gives it back by hand.
      for (const job of await queue.getJobs(['active'])) {
        try {
          await job?.remove()
        } catch {
          // BullMQ refuses a job whose lock is still held: that one is being
          // worked right now, by this process or another, and is not abandoned
        }
      }

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

    await this.processJob(job, queue)
    return true
  }

  private static queueNamesMatch(queue: Queue, compareQueueName: string): boolean {
    return (
      queue.name === parallelTestSafeQueueName(compareQueueName) ||
      queue.name === `{${parallelTestSafeQueueName(compareQueueName)}`
    )
  }

  /**
   * runs one fetched job to completion or failure, mirroring what a real worker
   * would do with a `RateLimitedPsychicJob`, then surfacing it so the spec goes
   * red rather than looping:
   *
   * - on a queue whose workers carry no BullMQ `limiter`, the job is failed with
   *   the misconfiguration error production would fail it with (so, with the
   *   queue's `attempts` > 1, it lands in `delayed` for its retry, out of
   *   `active`, where `clean()` can reach it), and that error is rethrown
   * - on a queue whose workers carry one, the job is moved back to the queue
   *   with no attempt counted (BullMQ's own rate-limit path), and the
   *   `RateLimitedPsychicJob` is rethrown
   *
   * Every other error only fails the job, as before.
   */
  private static async processJob(job: Job, queue: Queue) {
    try {
      const res = await background.doWork(job)
      await job.moveToCompleted(res, LOCK_TOKEN, false)
    } catch (err) {
      const misconfigured = background.misconfiguredRateLimitSignal(err, queue)
      if (misconfigured) {
        await job.moveToFailed(misconfigured, LOCK_TOKEN, false)
        throw misconfigured
      }

      if (err instanceof RateLimitedPsychicJob) {
        await job.moveToWait(LOCK_TOKEN)
        throw err
      }

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
