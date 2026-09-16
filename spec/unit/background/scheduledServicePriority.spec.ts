import { Job, JobSchedulerTemplateOptions } from 'bullmq'
import background from '../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'
import LastDummyScheduledService from '../../../test-app/src/app/services/LastDummyScheduledService.js'
import UrgentDummyScheduledService from '../../../test-app/src/app/services/UrgentDummyScheduledService.js'

/**
 * a scheduled service's `backgroundJobConfig` chooses its queue, so it must
 * also choose its priority: without one, open-source BullMQ enqueues the cron
 * job at no priority at all, which puts it in the `wait` list — and BullMQ
 * drains that list completely before it reads the prioritized set, so a
 * priority-less cron job is fetched ahead of every prioritized job sharing its
 * queue, `urgent` ones included.
 *
 * These specs pin the priority to the template BullMQ stores with the job
 * scheduler, by reading back the delayed job `upsertJobScheduler` produces out
 * of real Redis rather than spying on the call.
 */
describe('priority on a scheduled service', () => {
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

  async function theOnlyScheduledJob(): Promise<Job> {
    const jobs: Job[] = []
    for (const queue of background.queues) jobs.push(...(await queue.getDelayed()))
    expect(jobs).toHaveLength(1)
    return jobs[0]!
  }

  it("writes an urgent service's priority where open-source BullMQ reads it", async () => {
    await UrgentDummyScheduledService.schedule('* * * * *', 'classRunInBg', 'bottlearum')

    const job = await theOnlyScheduledJob()
    expect(job.opts.priority).toEqual(1)
  })

  it("writes a 'last' service's priority where open-source BullMQ reads it", async () => {
    await LastDummyScheduledService.schedule('* * * * *', 'classRunInBg', 'bottlearum')

    const job = await theOnlyScheduledJob()
    expect(job.opts.priority).toEqual(4)
  })

  it("writes the default priority for a service that configures none, rather than BullMQ's no-priority 0", async () => {
    await DefaultDummyScheduledService.schedule('* * * * *', 'classRunInBg', 'bottlearum')

    const job = await theOnlyScheduledJob()
    expect(job.opts.priority).toEqual(2)
  })

  context('when the caller passes its own scheduleOpts', () => {
    it("a caller-supplied priority overrides the service's", async () => {
      await background.scheduledMethod(UrgentDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: UrgentDummyScheduledService.globalName,
        args: ['bottlearum'],
        jobConfig: UrgentDummyScheduledService.backgroundJobConfig,
        scheduleOpts: { priority: 4 },
      })

      const job = await theOnlyScheduledJob()
      expect(job.opts.priority).toEqual(4)
    })

    /**
     * `JobSchedulerTemplateOptions` types `priority` as `priority?: number`, so
     * an options object built from a config value, an env var or a nullable
     * column — `{ priority: maybePriority }` where `maybePriority` is
     * `number | undefined` — carries an *explicitly undefined* own `priority`
     * key. Spread last, that key would erase the mapped priority and put every
     * cron run this scheduler produces back in the `wait` list.
     *
     * This repository compiles with `exactOptionalPropertyTypes: true`, which
     * refuses that literal, so the shape is built here rather than written out.
     * A consumer application on the default `false` writes it directly with no
     * complaint, and a JavaScript one is not checked at all.
     */
    it('keeps the config priority when scheduleOpts carries an explicitly undefined priority', async () => {
      const maybePriority: number | undefined = undefined
      const scheduleOpts: JobSchedulerTemplateOptions = {}
      Object.assign(scheduleOpts, { priority: maybePriority })
      expect(Object.hasOwn(scheduleOpts, 'priority')).toBe(true)

      await background.scheduledMethod(UrgentDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: UrgentDummyScheduledService.globalName,
        args: ['bottlearum'],
        jobConfig: UrgentDummyScheduledService.backgroundJobConfig,
        scheduleOpts,
      })

      const job = await theOnlyScheduledJob()
      expect(job.opts.priority).toEqual(1)
    })

    it('still applies other caller-supplied options alongside the mapped priority', async () => {
      await background.scheduledMethod(UrgentDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: UrgentDummyScheduledService.globalName,
        args: ['bottlearum'],
        jobConfig: UrgentDummyScheduledService.backgroundJobConfig,
        scheduleOpts: { attempts: 7 },
      })

      const job = await theOnlyScheduledJob()
      expect(job.opts.priority).toEqual(1)
      expect(job.opts.attempts).toEqual(7)
    })
  })
})
