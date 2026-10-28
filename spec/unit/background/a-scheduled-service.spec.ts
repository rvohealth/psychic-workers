import { Job } from 'bullmq'
import { background } from '../../../src/package-exports/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'

describe('a scheduled service', () => {
  context('queue priority', () => {
    let originalTestInvocation: PsychicWorkersAppTestInvocationType
    const serviceClass = DefaultDummyScheduledService
    const subject = async () => {
      await serviceClass.schedule('* * * * *', 'classRunInBg', 'bottlearum')
    }

    beforeEach(() => {
      const workersApp = PsychicAppWorkers.getOrFail()
      originalTestInvocation = workersApp.testInvocation
      workersApp.set('testInvocation', 'automatic')
      background.connect()

      vi.spyOn(background.queues[0]!, 'upsertJobScheduler').mockResolvedValue({} as Job)
    })

    afterEach(() => {
      PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
    })

    it('registers the scheduler without invoking the method in automatic test mode', async () => {
      const scheduledSpy = vi.spyOn(serviceClass, 'classRunInBg').mockResolvedValue(undefined)

      await subject()

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.queues[0]!.upsertJobScheduler).toHaveBeenCalledTimes(1)
      expect(scheduledSpy).not.toHaveBeenCalled()
    })

    it('calls upsertJobScheduler with correct args', async () => {
      await subject()
      const scheduledId = `${serviceClass.globalName}:classRunInBg`
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.queues[0]!.upsertJobScheduler).toHaveBeenCalledWith(
        scheduledId,
        { pattern: '* * * * *' },
        {
          name: 'BackgroundJobQueueStaticJob',
          // DefaultDummyScheduledService configures no priority, so the scheduler
          // template carries the mapped 'default' of 2
          opts: { priority: 2 },
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
