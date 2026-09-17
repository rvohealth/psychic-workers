import { Queue } from 'bullmq'
import background from '../../../src/background/index.js'
import parallelTestSafeQueueName from '../../../src/background/helpers/parallelTestSafeQueueName.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import { BackgroundQueuePriority } from '../../../src/types/background.js'
import LastDummyServiceInNamedWorkstream from '../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'

/**
 * a job on a named workstream carries a group id (the workstream name), and a
 * group is a BullMQ Pro concept. These specs pin the priority to the top level
 * of the job's options, where open-source BullMQ reads it, rather than only
 * inside the Pro-only `group` — which would leave `priority` on a workstream's
 * `backgroundJobConfig` doing nothing at all without Pro.
 *
 * They read the job back out of real Redis rather than spying on `queue.add`,
 * since the point is that BullMQ itself acts on the priority.
 */
describe('priority on a named workstream', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()
  })

  afterEach(async () => {
    await WorkerTestUtils.clean()
    PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
  })

  function snazzyQueue(): Queue {
    return background.queues.find(queue => queue.name === parallelTestSafeQueueName('snazzy'))!
  }

  async function theOnlyJobInSnazzy() {
    const jobs = await snazzyQueue().getJobs(['waiting', 'prioritized', 'delayed', 'active', 'failed'])
    expect(jobs).toHaveLength(1)
    return jobs[0]!
  }

  context('from the backgroundJobConfig', () => {
    it("writes the workstream's priority where open-source BullMQ reads it, sorting the job into prioritized", async () => {
      await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'howyadoin')

      const job = await theOnlyJobInSnazzy()
      // 'last'
      expect(job.opts.priority).toEqual(4)
      expect(await job.getState()).toEqual('prioritized')

      // and the BullMQ Pro group priority is written alongside it, not instead of it
      expect((job.opts as { group?: unknown }).group).toEqual({ id: 'snazzy', priority: 4 })
    })
  })

  context('overridden through backgroundWith', () => {
    const subject = async (priority: BackgroundQueuePriority) =>
      await LastDummyServiceInNamedWorkstream.backgroundWith({ priority }, 'classRunInBG', 'howyadoin')

    it('maps urgent to 1', async () => {
      await subject('urgent')

      const job = await theOnlyJobInSnazzy()
      expect(job.opts.priority).toEqual(1)
      expect(await job.getState()).toEqual('prioritized')
    })

    it('maps not_urgent to 3', async () => {
      await subject('not_urgent')

      const job = await theOnlyJobInSnazzy()
      expect(job.opts.priority).toEqual(3)
      expect(await job.getState()).toEqual('prioritized')
    })

    it('maps default to 2', async () => {
      await subject('default')

      const job = await theOnlyJobInSnazzy()
      expect(job.opts.priority).toEqual(2)
      expect(await job.getState()).toEqual('prioritized')
    })
  })
})
