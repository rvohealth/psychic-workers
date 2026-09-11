import { Job } from 'bullmq'
import BaseScheduledService from '../../../src/background/BaseScheduledService.js'
import { background } from '../../../src/package-exports/index.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'

describe('a scheduled service', () => {
  it('derives a local locator for an eligible child method', () => {
    const serviceClass = DefaultDummyScheduledService

    const locator = serviceClass.jobSchedulerLocator('classRunInBg')

    expect(background.jobSchedulerIdentityFromLocator(locator)).toMatchObject({
      globalName: serviceClass.globalName,
      method: 'classRunInBg',
      route: { kind: 'default' },
    })
  })

  it('lets a base-class-only seed delegate a hard-coded locator to Background', async () => {
    const locator = 'psychic-job-scheduler:v1:WyJzZXJ2aWNlcy9EaWdlc3RzIiwiZGVsaXZlciIsWyJkZWZhdWx0Il1d'
    const connect = vi.spyOn(background, 'connect')
    const unscheduleByLocator = vi.spyOn(background, 'unscheduleByLocator').mockResolvedValue(true)

    await expect(BaseScheduledService.unschedule(locator)).resolves.toBe(true)

    expect(connect).toHaveBeenCalled()
    expect(unscheduleByLocator).toHaveBeenCalledWith(locator)
  })

  context('queue priority', () => {
    const serviceClass = DefaultDummyScheduledService
    const subject = async () => {
      await serviceClass.schedule('* * * * *', 'classRunInBg', 'bottlearum')
    }

    beforeEach(() => {
      process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
      background.connect()

      vi.spyOn(background.queues[0]!, 'upsertJobScheduler').mockResolvedValue({} as Job)
    })

    afterEach(() => {
      process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
    })

    it('calls upsertJobScheduler with correct args', async () => {
      await subject()
      const identity = background.jobSchedulerIdentity(
        serviceClass.globalName,
        'classRunInBg',
        serviceClass.backgroundJobConfig,
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.queues[0]!.upsertJobScheduler).toHaveBeenCalledWith(
        identity.jobSchedulerId,
        { pattern: '* * * * *' },
        {
          name: 'BackgroundJobQueueStaticJob',
          opts: {},
          data: {
            globalName: `services/${serviceClass.name}`,
            args: ['bottlearum'],
            method: 'classRunInBg',
          },
        },
      )
    })
  })
})
