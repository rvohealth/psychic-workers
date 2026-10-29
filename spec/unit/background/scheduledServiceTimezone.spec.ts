import { DateTime } from '@rvoh/dream'
import background from '../../../src/background/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'

describe('the time zone of a scheduled service', () => {
  const serviceClass = DefaultDummyScheduledService
  let schedulerId: string
  const pattern = '0 9 * * *'
  const nextYear = DateTime.now().year + 1

  beforeEach(async () => {
    schedulerId = serviceClass.unscheduleId('classRunInBg')
    await WorkerTestUtils.clean()
    // Keep Redis and the test harness on real timers; only freeze the clock
    // BullMQ uses when calculating the next cron occurrence.
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await WorkerTestUtils.clean()
  })

  it.each([1, 7])('runs a 09:00 cron at 09:00 UTC in month %i', async month => {
    const midnight = DateTime.fromObject({ year: nextYear, month, day: 1 }, { zone: 'UTC' })
    vi.setSystemTime(midnight.toMillis())

    await serviceClass.schedule(pattern, 'classRunInBg', 'utc message')

    const scheduler = await background.queues[0]!.getJobScheduler(schedulerId)
    expect(scheduler).toEqual(
      expect.objectContaining({
        pattern,
        tz: 'UTC',
        next: midnight.plus({ hours: 9 }).toMillis(),
      }),
    )
  })

  it('updates an existing scheduler to UTC when the service registers again', async () => {
    const midnight = DateTime.fromObject({ year: nextYear, month: 7, day: 1 }, { zone: 'UTC' })
    vi.setSystemTime(midnight.toMillis())
    const queue = background.queues[0]!

    // Reproduce a scheduler registered by the previous version, which omitted tz.
    await queue.upsertJobScheduler(
      schedulerId,
      { pattern },
      {
        name: 'BackgroundJobQueueStaticJob',
        data: { globalName: serviceClass.globalName, method: 'classRunInBg', args: ['old message'] },
      },
    )
    expect((await queue.getJobScheduler(schedulerId))!.tz).toBeUndefined()

    await serviceClass.schedule(pattern, 'classRunInBg', 'updated message')

    const schedulers = await queue.getJobSchedulers()
    expect(schedulers).toHaveLength(1)
    expect(schedulers[0]).toEqual(
      expect.objectContaining({
        key: schedulerId,
        tz: 'UTC',
        next: midnight.plus({ hours: 9 }).toMillis(),
      }),
    )
    const jobs = await queue.getDelayed()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.opts.repeat?.tz).toEqual('UTC')
    expect(jobs[0]!.opts.priority).toEqual(2)
    expect(jobs[0]!.data).toEqual({
      globalName: serviceClass.globalName,
      method: 'classRunInBg',
      args: ['updated message'],
    })
  })
})
