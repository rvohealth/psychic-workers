import { Job, Worker, WorkerOptions } from 'bullmq'
import background from '../../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'
import LastDummyServiceInNamedWorkstream from '../../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'

async function allDelayedJobs() {
  background.connect()
  const delayedJobs = await Promise.all(background.queues.map(queue => queue.getDelayed()))
  return delayedJobs.flat()
}

describe('.clean', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()
  })

  afterEach(async () => {
    await WorkerTestUtils.clean()
    const workersApp = PsychicAppWorkers.getOrFail()
    workersApp.set('testInvocation', originalTestInvocation)
  })

  context('with existing delayed jobs', () => {
    it('clears the delayed jobs', async () => {
      vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})

      await DummyService.backgroundWithDelay({ hours: 24 }, 'classRunInBG', 'delayed message')

      expect(await allDelayedJobs()).not.toHaveLength(0)

      await WorkerTestUtils.clean()

      expect(await allDelayedJobs()).toHaveLength(0)
    })
  })

  /**
   * `drain` does not touch `active`, so a job fetched with `getNextJob` and
   * never moved on outlives every other step in `clean()` — and outlives the
   * process, leaving a job in `active` that the next run of the suite counts.
   * A job whose lock is still live is another process's work and is left alone;
   * one whose lock has lapsed is abandoned, and is removed.
   */
  context('with a job left in active', () => {
    it('leaves a locked one alone and removes one whose lock has lapsed', async () => {
      vi.spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG').mockImplementation(async () => {})
      await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'abandoned message')

      background.connect()
      const queue = background.queues.find(
        queue => queue.name === WorkerTestUtils.parallelTestSafeQueueName('snazzy'),
      )!
      const worker = new Worker(queue.name, async () => {}, {
        autorun: false,
        connection: queue.client,
        concurrency: 1,
      } as WorkerOptions)

      try {
        const job = await worker.getNextJob('clean-spec-lock-token')
        expect(await job.getState()).toEqual('active')

        // the lock is live, so this job is someone's work in progress
        await WorkerTestUtils.clean()
        expect(await job.getState()).toEqual('active')

        // the process holding the lock is gone; the lock is all that was
        // keeping the job out of reach
        const client = await queue.client
        await client.del(`${queue.toKey(job.id!)}:lock`)

        await WorkerTestUtils.clean()
        expect(await Job.fromId(queue, job.id!)).toBeUndefined()
        expect(await queue.getActiveCount()).toEqual(0)
      } finally {
        await worker.close()
      }
    })
  })
})
