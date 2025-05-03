import { Job } from 'bullmq'
import { background } from '../../../src/index.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'

describe('a scheduled service', () => {
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
      const scheduledId = `${serviceClass.globalName}:classRunInBg`
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.queues[0]!.upsertJobScheduler).toHaveBeenCalledWith(
        scheduledId,
        { pattern: '* * * * *' },
        {
          name: scheduledId,
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
