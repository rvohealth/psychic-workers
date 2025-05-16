import { Job, Queue, WorkerOptions } from 'bullmq'
import background, { Background } from '../background/index.js'
import { BackgroundJobData } from '../types/background.js'

export default class WorkerTestUtils {
  public static async work() {
    background.connect()
    const queues = background.queues
    let workWasDone: boolean = true

    do {
      workWasDone = false
      for (const queue of queues) {
        workWasDone ||= await this.workOne(queue)
      }
    } while (workWasDone)
  }

  public static async workScheduled(opts: { queue?: string; for?: { globalName: string } } = {}) {
    background.connect()

    const queues = opts.queue
      ? background.queues.filter(queue => queue.name === opts.queue)
      : background.queues

    if (opts.queue && !queues.length)
      throw new Error(
        `Expected to find queue with name: ${opts.queue}, but none were found by that name. The queue names available are: ${background.queues.map(queue => queue.name).join(', ')}`,
      )

    for (const queue of queues) {
      const jobs = (await queue.getDelayed()) as Job[]
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

    const lockToken = 'test-worker'

    const job = await worker.getNextJob(lockToken)
    if (!job) return false

    await this.processJob(job)
    return true
  }

  private static async processJob(job: Job) {
    const lockToken = 'test-worker'
    try {
      const res = await background.doWork(job)
      await job.moveToCompleted(res, lockToken, false)
    } catch (err) {
      await job.moveToFailed(err as Error, lockToken, false)
    }
  }
}
