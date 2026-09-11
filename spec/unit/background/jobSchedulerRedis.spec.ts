import { Job, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import BaseScheduledService from '../../../src/background/BaseScheduledService.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import { background } from '../../../src/package-exports/index.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'

const LEGACY_SCHEDULER_ID = 'services/DefaultDummyScheduledService:classRunInBg'
const LEGACY_LOCATOR =
  'psychic-job-scheduler:v1:WyJzZXJ2aWNlcy9EZWZhdWx0RHVtbXlTY2hlZHVsZWRTZXJ2aWNlIiwiY2xhc3NSdW5JbkJnIixbImRlZmF1bHQiXV0'
const REMOVED_SERVICE_SCHEDULER_ID = 'services/RemovedScheduledService:deliver'
const REMOVED_SERVICE_LOCATOR =
  'psychic-job-scheduler:v1:WyJzZXJ2aWNlcy9SZW1vdmVkU2NoZWR1bGVkU2VydmljZSIsImRlbGl2ZXIiLFsiZGVmYXVsdCJdXQ'

function jobHasGlobalName(job: Job<unknown>, globalName: string) {
  return (job.data as { globalName?: unknown }).globalName === globalName
}

describe('public job scheduler operations against Redis', () => {
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

  it('composes schedule, inventory, exact removal, and route-wide unscheduling', async () => {
    await DefaultDummyScheduledService.schedule('0 7 1 1 *', 'classRunInBg', 'first')

    const [row] = (await background.getJobSchedulers()).filter(
      scheduler => scheduler.globalName === DefaultDummyScheduledService.globalName,
    )
    expect(row).toMatchObject({
      locator: LEGACY_LOCATOR,
      globalName: DefaultDummyScheduledService.globalName,
      method: 'classRunInBg',
      pattern: '0 7 1 1 *',
      origin: { source: 'current', route: { kind: 'default' } },
    })
    expect(await background.removeJobScheduler({ ...row!, origin: { ...row!.origin } })).toBe(true)
    expect(await background.removeJobScheduler(row!)).toBe(false)

    await DefaultDummyScheduledService.schedule('0 8 1 1 *', 'classRunInBg', 'second')
    expect(await DefaultDummyScheduledService.unschedule(LEGACY_LOCATOR)).toBe(true)
    expect(await DefaultDummyScheduledService.unschedule(LEGACY_LOCATOR)).toBe(false)
  })

  it('adopts a checked-in 2.5 scheduler id and removes its next delayed occurrence', async () => {
    const queue = background.queues[0]!
    await queue.upsertJobScheduler(
      LEGACY_SCHEDULER_ID,
      { pattern: '0 6 1 1 *' },
      {
        name: 'BackgroundJobQueueStaticJob',
        data: {
          globalName: 'services/DefaultDummyScheduledService',
          method: 'classRunInBg',
          args: ['from-2.5'],
        },
      },
    )

    await DefaultDummyScheduledService.schedule('0 9 1 1 *', 'classRunInBg', 'from-2.6')

    const adoptedSchedulers = (await queue.getJobSchedulers()).filter(
      scheduler => scheduler.key === LEGACY_SCHEDULER_ID,
    )
    expect(adoptedSchedulers).toHaveLength(1)
    expect(adoptedSchedulers[0]!.pattern).toBe('0 9 1 1 *')
    expect(
      (await queue.getDelayed()).some(job => jobHasGlobalName(job, DefaultDummyScheduledService.globalName)),
    ).toBe(true)

    await expect(DefaultDummyScheduledService.unschedule(LEGACY_LOCATOR)).resolves.toBe(true)
    expect((await queue.getJobSchedulers()).some(scheduler => scheduler.key === LEGACY_SCHEDULER_ID)).toBe(
      false,
    )
    expect(
      (await queue.getDelayed()).some(job => jobHasGlobalName(job, DefaultDummyScheduledService.globalName)),
    ).toBe(false)
  })

  it('supports checked-in-locator seed cleanup with only the base class', async () => {
    const queue = background.queues[0]!
    await queue.upsertJobScheduler(
      REMOVED_SERVICE_SCHEDULER_ID,
      { pattern: '0 10 1 1 *' },
      {
        name: 'BackgroundJobQueueStaticJob',
        data: {
          globalName: 'services/RemovedScheduledService',
          method: 'deliver',
          args: [],
        },
      },
    )

    await expect(BaseScheduledService.unschedule(REMOVED_SERVICE_LOCATOR)).resolves.toBe(true)
    await expect(BaseScheduledService.unschedule(REMOVED_SERVICE_LOCATOR)).resolves.toBe(false)
    await expect(BaseScheduledService.unschedule('deliver')).rejects.toThrow()
    expect(
      (await queue.getDelayed()).some(job => jobHasGlobalName(job, 'services/RemovedScheduledService')),
    ).toBe(false)
  })

  it('leaves an already-emitted waiting occurrence runnable while removing future scheduling', async () => {
    const queue = background.queues[0]!
    await DefaultDummyScheduledService.schedule('* * * * * *', 'classRunInBg', 'waiting')
    const delayedJob = (await queue.getDelayed()).find(job =>
      jobHasGlobalName(job, DefaultDummyScheduledService.globalName),
    )!
    await delayedJob.promote()
    expect(await delayedJob.getState()).toBe('waiting')

    await expect(DefaultDummyScheduledService.unschedule(LEGACY_LOCATOR)).resolves.toBe(true)
    expect((await queue.getJobSchedulers()).some(scheduler => scheduler.key === LEGACY_SCHEDULER_ID)).toBe(
      false,
    )
    expect((await queue.getWaiting()).some(job => job.id === delayedJob.id)).toBe(true)

    const workerConnection = new Redis({
      ...(process.env.REDIS_USER ? { username: process.env.REDIS_USER } : {}),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
      maxRetriesPerRequest: null,
    })
    const worker = new Worker(
      queue.name,
      async () => {
        await Promise.resolve()
      },
      {
        autorun: false,
        connection: workerConnection,
      },
    )
    const token = 'job-scheduler-waiting-contract'

    try {
      const runnableJob = await worker.getNextJob(token, { block: false })
      if (!runnableJob) throw new Error('Expected the emitted scheduler occurrence to remain runnable')
      expect(runnableJob.id).toBe(delayedJob.id)
      expect(await runnableJob.getState()).toBe('active')

      await runnableJob.moveToCompleted(undefined, token, false)
      expect(
        (await queue.getDelayed()).some(job =>
          jobHasGlobalName(job, DefaultDummyScheduledService.globalName),
        ),
      ).toBe(false)
    } finally {
      await worker.close()
      workerConnection.disconnect()
    }
  })

  it('removes the scheduler without cancelling its already-active occurrence', async () => {
    const queue = background.queues[0]!
    await DefaultDummyScheduledService.schedule('* * * * * *', 'classRunInBg', 'active')
    const delayedJob = (await queue.getDelayed()).find(job =>
      jobHasGlobalName(job, DefaultDummyScheduledService.globalName),
    )!
    await delayedJob.promote()

    const workerConnection = new Redis({
      ...(process.env.REDIS_USER ? { username: process.env.REDIS_USER } : {}),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
      maxRetriesPerRequest: null,
    })
    const worker = new Worker(
      queue.name,
      async () => {
        await Promise.resolve()
      },
      {
        autorun: false,
        connection: workerConnection,
      },
    )
    const token = 'job-scheduler-active-contract'

    try {
      const activeJob = await worker.getNextJob(token, { block: false })
      if (!activeJob) throw new Error('Expected the promoted scheduler occurrence to become active')
      expect(await activeJob.getState()).toBe('active')

      await expect(DefaultDummyScheduledService.unschedule(LEGACY_LOCATOR)).resolves.toBe(true)
      expect(await activeJob.getState()).toBe('active')
      expect(
        (await queue.getDelayed()).some(job =>
          jobHasGlobalName(job, DefaultDummyScheduledService.globalName),
        ),
      ).toBe(false)

      await activeJob.moveToCompleted(undefined, token, false)
    } finally {
      await worker.close()
      workerConnection.disconnect()
    }
  })
})
