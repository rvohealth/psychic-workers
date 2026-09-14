import { Job } from 'bullmq'
import background from '../../../../src/background/index.js'
import parallelTestSafeQueueName from '../../../../src/background/helpers/parallelTestSafeQueueName.js'
import { RateLimitedPsychicJob } from '../../../../src/package-exports/errors.js'
import PsychicAppWorkers, {
  PsychicBackgroundSimpleOptions,
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'
import initializePsychicApp from '../../../../test-app/src/cli/helpers/initializePsychicApp.js'

const PAUSE_QUEUE_FOR_SECONDS = 5

/**
 * `WorkerTestUtils` works the `background` singleton, which connects once per
 * spec file — in the setup hook's first `beforeEach`, from whatever background
 * options the workers app holds at that moment. This file connects it first,
 * in `beforeAll`, with a global `defaultBullMQWorkerOptions.limiter` added to
 * the test app's configuration, so the default workstream's workers carry a
 * `limiter` and a default-queue job may signal `RateLimitedPsychicJob`.
 *
 * A default-queue job carries a top-level BullMQ `priority` (a workstream job's
 * is nested under `group`, invisible to open-source BullMQ), so when `work()`
 * moves it back to the queue it lands in `prioritized`, not `waiting`.
 */
describe('.work on the default workstream under a global defaultBullMQWorkerOptions.limiter', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  beforeAll(async () => {
    await initializePsychicApp()
    const workersApp = PsychicAppWorkers.getOrFail()
    workersApp.set('background', {
      ...(workersApp.backgroundOptions as PsychicBackgroundSimpleOptions),
      defaultBullMQWorkerOptions: { limiter: { max: 10, duration: 1000 } },
    })
    background.connect()
  })

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()
  })

  afterEach(() => {
    PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
  })

  it('rejects with RateLimitedPsychicJob and puts the job back in prioritized with no attempt counted, where clean() removes it', async () => {
    vi.spyOn(DummyService, 'classRunInBG').mockRejectedValue(
      new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS }),
    )
    await DummyService.background('classRunInBG', 'message 1')

    const queue = background.queues.find(
      queue => queue.name === parallelTestSafeQueueName('TestappBackgroundJobQueue'),
    )!
    const jobs = await queue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'failed'])
    expect(jobs).toHaveLength(1)
    const jobId = jobs[0]!.id!

    await expect(WorkerTestUtils.work()).rejects.toThrow(RateLimitedPsychicJob)

    const job = (await Job.fromId(queue, jobId))!
    expect(await job.getState()).toEqual('prioritized')
    expect(job.attemptsMade).toEqual(0)
    expect(await queue.getActiveCount()).toEqual(0)
    expect(await queue.getFailedCount()).toEqual(0)

    // no pause is applied on this path: the throwaway test worker carries no limiter
    expect(await (await queue.client).pttl(queue.toKey('limiter'))).toEqual(-2)

    await WorkerTestUtils.clean()
    expect(await queue.getPrioritizedCount()).toEqual(0)
    expect(await Job.fromId(queue, jobId)).toBeUndefined()
  })
})
