import { Job, Queue } from 'bullmq'
import background from '../../../../src/background/index.js'
import parallelTestSafeQueueName from '../../../../src/background/helpers/parallelTestSafeQueueName.js'
import RateLimitedPsychicJobThrownFromWorkerWithoutLimiter from '../../../../src/error/background/RateLimitedPsychicJobThrownFromWorkerWithoutLimiter.js'
import { RateLimitedPsychicJob } from '../../../../src/package-exports/errors.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import User from '../../../../test-app/src/app/models/User.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'
import LastDummyServiceInNamedWorkstream from '../../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'
import UrgentDummyService from '../../../../test-app/src/app/services/UrgentDummyService.js'

describe('.work', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()
  })

  afterEach(() => {
    const workersApp = PsychicAppWorkers.getOrFail()
    workersApp.set('testInvocation', originalTestInvocation)
  })

  context('with no jobs', () => {
    it('does nothing, but does not stall', async () => {
      const serviceSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const modelSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})

      await WorkerTestUtils.work()

      expect(serviceSpy).not.toHaveBeenCalled()
      expect(modelSpy).not.toHaveBeenCalled()
    }, 5000)
  })

  context('with existing jobs', () => {
    it('works off all jobs in all queues', async () => {
      const bgSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const userSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      const urgentSpy = vi.spyOn(UrgentDummyService, 'classRunInBG').mockImplementation(async () => {})
      const workstreamSpy = vi
        .spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG')
        .mockImplementation(async () => {})

      await DummyService.background('classRunInBG', 'message 1')
      await DummyService.background('classRunInBG', 'message 2')
      await User.background('classRunInBG', 'message 3')
      await UrgentDummyService.background('classRunInBG', 'message 4')
      await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'message 5')

      expect(bgSpy).not.toHaveBeenCalled()
      expect(userSpy).not.toHaveBeenCalled()
      expect(urgentSpy).not.toHaveBeenCalled()
      expect(workstreamSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.work()
      expect(bgSpy).toHaveBeenCalledWith('message 1', expect.any(Job))
      expect(bgSpy).toHaveBeenCalledWith('message 2', expect.any(Job))
      expect(userSpy).toHaveBeenCalledWith('message 3', expect.any(Job))
      expect(urgentSpy).toHaveBeenCalledWith('message 4', expect.any(Job))
      expect(workstreamSpy).toHaveBeenCalledWith('message 5', expect.any(Job))
    })
  })

  context('when provided a queue', () => {
    it('only works of the jobs from that queue', async () => {
      const bgSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      await DummyService.background('classRunInBG', 'message 1')
      expect(bgSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.work({ queue: 'snazzy' })
      expect(bgSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.work({ queue: 'TestappBackgroundJobQueue' })
      expect(bgSpy).toHaveBeenCalledWith('message 1', expect.any(Job))
    })
  })

  context('when a job throws RateLimitedPsychicJob', () => {
    const PAUSE_QUEUE_FOR_SECONDS = 5

    function queueNamed(name: string): Queue {
      return background.queues.find(queue => queue.name === parallelTestSafeQueueName(name))!
    }

    async function theOnlyJobIn(queue: Queue) {
      const jobs = await queue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'failed'])
      expect(jobs).toHaveLength(1)
      return jobs[0]!
    }

    async function limiterKeyTtl(queue: Queue) {
      return (await queue.client).pttl(queue.toKey('limiter'))
    }

    context('on a named workstream whose workers carry a limiter (snazzy sets rateLimit)', () => {
      it('rejects with RateLimitedPsychicJob and puts the job back in prioritized with no attempt counted, where clean() drains it', async () => {
        vi.spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG').mockRejectedValue(
          new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS }),
        )
        await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'message 1')

        const queue = queueNamed('snazzy')
        const jobId = (await theOnlyJobIn(queue)).id!

        await expect(WorkerTestUtils.work()).rejects.toThrow(RateLimitedPsychicJob)

        // BullMQ's own attempt-free path: back onto the queue unworked. The state
        // is `prioritized` rather than `waiting` because this service's
        // `backgroundJobConfig` sets `priority: 'last'`, and a workstream job now
        // carries its priority at the top level where open-source BullMQ reads it
        const job = (await Job.fromId(queue, jobId))!
        expect(await job.getState()).toEqual('prioritized')
        expect(job.attemptsMade).toEqual(0)
        expect(await queue.getActiveCount()).toEqual(0)
        expect(await queue.getFailedCount()).toEqual(0)

        // no pause is applied on this path: the test worker carries no limiter,
        // and a limiter key would outlive clean()
        expect(await limiterKeyTtl(queue)).toEqual(-2)

        await WorkerTestUtils.clean()
        expect(await queue.getWaitingCount()).toEqual(0)
        expect(await queue.getActiveCount()).toEqual(0)
        expect(await Job.fromId(queue, jobId)).toBeUndefined()
      })
    })

    context('on the default workstream, whose workers carry no limiter', () => {
      it('rejects with the misconfiguration error, failing the job onto its ordinary retry schedule, where clean() drains it', async () => {
        vi.spyOn(DummyService, 'classRunInBG').mockRejectedValue(
          new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS }),
        )
        await DummyService.background('classRunInBG', 'message 1')

        const queue = queueNamed('TestappBackgroundJobQueue')
        const jobId = (await theOnlyJobIn(queue)).id!

        await expect(WorkerTestUtils.work()).rejects.toThrow(
          RateLimitedPsychicJobThrownFromWorkerWithoutLimiter,
        )

        // an ordinary failure: with the test app's `attempts: 20` and
        // exponential backoff, the job is parked in `delayed` for its retry
        const job = (await Job.fromId(queue, jobId))!
        expect(await job.getState()).toEqual('delayed')
        expect(job.attemptsMade).toEqual(1)
        expect(job.failedReason).toContain(
          `RateLimitedPsychicJob (pause the queue for ${PAUSE_QUEUE_FOR_SECONDS} seconds)`,
        )
        expect(job.failedReason).toContain('the default workstream')
        expect(await queue.getActiveCount()).toEqual(0)
        expect(await queue.getFailedCount()).toEqual(0)
        expect(await limiterKeyTtl(queue)).toEqual(-2)

        await WorkerTestUtils.clean()
        expect(await queue.getDelayedCount()).toEqual(0)
        expect(await Job.fromId(queue, jobId)).toBeUndefined()
      })
    })

    context('any other error', () => {
      it('still fails the job without rejecting, as before', async () => {
        vi.spyOn(DummyService, 'classRunInBG').mockRejectedValue(new Error('an ordinary failure'))
        await DummyService.background('classRunInBG', 'message 1')

        const queue = queueNamed('TestappBackgroundJobQueue')
        const jobId = (await theOnlyJobIn(queue)).id!

        await WorkerTestUtils.work()

        const job = (await Job.fromId(queue, jobId))!
        expect(await job.getState()).toEqual('delayed')
        expect(job.attemptsMade).toEqual(1)
        expect(job.failedReason).toEqual('an ordinary failure')
      })
    })
  })
})
