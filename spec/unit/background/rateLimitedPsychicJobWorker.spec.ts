import { PsychicApp } from '@rvoh/psychic'
import { Job, RateLimitError, Worker } from 'bullmq'
import parallelTestSafeQueueName from '../../../src/background/helpers/parallelTestSafeQueueName.js'
import { RateLimitedPsychicJob } from '../../../src/package-exports/errors.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicWorkersAppTestInvocationType } from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import LastDummyServiceInNamedWorkstream from '../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'

const LOCK_TOKEN = 'psychic-rate-limit-spec-worker'
const PAUSE_QUEUE_FOR_SECONDS = 5

/**
 * The one real-BullMQ check on the translation: a Worker built by
 * `Background#connect` for the test app's `snazzy` workstream (which sets
 * `rateLimit`, so the worker carries a `limiter`) is handed a job that throws
 * `RateLimitedPsychicJob`. BullMQ must recognize the `RateLimitError` the
 * processor throws and take its own rate-limit path: the job goes back to
 * `prioritized` with no attempt counted and no `failed` event, and the queue's
 * limiter key is set for `pauseQueueForSeconds` seconds — rounded up, when the
 * job asks for a fraction of a second.
 *
 * Needs Redis; runs with `testInvocation: 'manual'` so the job is actually
 * enqueued. The worker is never started (`autorun` is false under test), so
 * the job is fetched and processed by hand.
 */
describe('a real worker carrying a limiter, when its job throws RateLimitedPsychicJob', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType
  let backgroundInstance: Background

  function snazzyQueueName() {
    return parallelTestSafeQueueName('snazzy')
  }

  /**
   * the processor `Background#connect` handed this worker. BullMQ keeps it
   * private, but running it by hand is the only way to observe the error the
   * processor throws — `processJob` translates it and never rethrows.
   */
  function processorOf(worker: Worker): (job: Job) => Promise<void> {
    return (worker as unknown as { processFn: (job: Job) => Promise<void> }).processFn
  }

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()

    backgroundInstance = new Background()
    backgroundInstance.connect({ activateWorkers: true })
  })

  afterEach(async () => {
    // the limiter key outlives `clean()`, which never removes it
    for (const queue of backgroundInstance.queues) await queue.removeRateLimitKey()

    // only the workers: the Redis connections are the test app's own, shared
    // with the `background` singleton every other spec uses
    for (const worker of backgroundInstance.workers) await worker.close()

    await WorkerTestUtils.clean()
    PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
  })

  it('pauses the queue for pauseQueueForSeconds and puts the job back in prioritized, counting no attempt and emitting no failed event', async () => {
    vi.spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG').mockRejectedValue(
      new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS }),
    )
    await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'howyadoin')

    const queue = backgroundInstance.queues.find(queue => queue.name === snazzyQueueName())!
    const worker: Worker = backgroundInstance.workers.find(worker => worker.name === snazzyQueueName())!
    expect(worker.opts.limiter).toEqual({ max: 1, duration: 1 })

    const failedEvents: unknown[] = []
    worker.on('failed', (...args) => failedEvents.push(args))
    const logSpy = vi.spyOn(PsychicApp, 'logWithLevel').mockImplementation(() => {})
    const rateLimitSpy = vi.spyOn(queue, 'rateLimit')

    const job = await worker.getNextJob(LOCK_TOKEN)
    expect(job).toBeInstanceOf(Job)
    expect(await job.getState()).toEqual('active')

    await worker.processJob(job, LOCK_TOKEN, () => false)

    const jobAfter = (await Job.fromId(queue, job.id!))!
    // `prioritized`, not `waiting`: this service's `backgroundJobConfig` sets
    // `priority: 'last'`, which a workstream job now carries at the top level
    // where open-source BullMQ reads it
    expect(await jobAfter.getState()).toEqual('prioritized')
    expect(jobAfter.attemptsMade).toEqual(0)
    expect(failedEvents).toEqual([])
    expect(await queue.getFailedCount()).toEqual(0)
    expect(await queue.getActiveCount()).toEqual(0)

    // whole milliseconds, always: BullMQ hands the value to Redis `SET … PX`
    const [pauseMs] = rateLimitSpy.mock.calls[0]!
    expect(pauseMs).toEqual(PAUSE_QUEUE_FOR_SECONDS * 1000)
    expect(Number.isSafeInteger(pauseMs) && pauseMs > 0).toBe(true)

    const limiterTtl = await (await queue.client).pttl(queue.toKey('limiter'))
    expect(limiterTtl).toBeGreaterThan(PAUSE_QUEUE_FOR_SECONDS * 1000 - 1000)
    expect(limiterTtl).toBeLessThanOrEqual(PAUSE_QUEUE_FOR_SECONDS * 1000)

    // the pause is announced under the queue's name, the value applied as the job gave it
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      `[psychic-workers] pausing queue ${queue.name} for ${PAUSE_QUEUE_FOR_SECONDS}s: a job threw RateLimitedPsychicJob`,
    )
  })

  // the field is a lower bound on the pause, so a fraction of a second rounds
  // up: 2.5 seconds pauses for 3, never for 2
  it('rounds a fractional pauseQueueForSeconds up, and surfaces as BullMQ’s RateLimitError', async () => {
    vi.spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG').mockRejectedValue(
      new RateLimitedPsychicJob({ pauseQueueForSeconds: 2.5 }),
    )
    await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'howyadoin')

    const queue = backgroundInstance.queues.find(queue => queue.name === snazzyQueueName())!
    const worker: Worker = backgroundInstance.workers.find(worker => worker.name === snazzyQueueName())!

    const logSpy = vi.spyOn(PsychicApp, 'logWithLevel').mockImplementation(() => {})
    const rateLimitSpy = vi.spyOn(queue, 'rateLimit')

    const job = await worker.getNextJob(LOCK_TOKEN)
    expect(job).toBeInstanceOf(Job)

    // the processor itself, so the error it throws is observable rather than
    // swallowed by the worker's own rate-limit handling
    await expect(processorOf(worker)(job)).rejects.toThrow(RateLimitError)

    // running the processor by hand skips everything `processJob` would have
    // done with the error, including moving the job off `active` and releasing
    // the lock this spec took in `getNextJob`. Do it by hand too — a locked
    // `active` job survives `afterEach`, since `WorkerTestUtils.clean()`
    // deliberately leaves locked jobs alone, and the next run of the suite
    // would count it. `moveToWait` is the same destination BullMQ's own
    // rate-limit path sends it to.
    await job.moveToWait(LOCK_TOKEN)
    expect(await queue.getActiveCount()).toEqual(0)

    const [pauseMs] = rateLimitSpy.mock.calls[0]!
    expect(pauseMs).toEqual(3000)

    const limiterTtl = await (await queue.client).pttl(queue.toKey('limiter'))
    expect(limiterTtl).toBeGreaterThan(2000)
    expect(limiterTtl).toBeLessThanOrEqual(3000)

    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      `[psychic-workers] pausing queue ${queue.name} for 3s: a job threw RateLimitedPsychicJob`,
    )
  })
})
